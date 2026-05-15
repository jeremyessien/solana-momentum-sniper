import { randomUUID } from 'node:crypto';
import { parsePumpfunActivityEvents } from '../src/activity/pumpfunTradeParser.js';
import { parsePumpfunCreate } from '../src/detection/pumpfunCreateParser.js';
import { createSystemClock } from '../src/infrastructure/clock/clock.js';
import { loadConfig } from '../src/infrastructure/config/configLoader.js';
import { createEventBus } from '../src/infrastructure/eventBus/eventBus.js';
import { createHeliusAdapter } from '../src/infrastructure/helius/heliusAdapter.js';
import { createKitSubscriptionSource } from '../src/infrastructure/helius/kitSubscriptionSource.js';
import { createLogger } from '../src/infrastructure/logger/logger.js';
import type { EventMap } from '../src/shared/eventMap.js';
import { RUGCHECK_API_BASE_URL } from '../src/shared/externalApis.js';
import { PUMP_FUN_PROGRAM_ID } from '../src/shared/launchpadPrograms.js';

const CAPTURE_TIMEOUT_MS = 30_000;
const OBSERVATION_WINDOW_MS = 5 * 60 * 1000;
const MAX_EVENTS = 60;
const RUGCHECK_PROBE_TIMEOUT_MS = 4_000;

type ProbeSummary = {
  status: number | 'network-error';
  bodySize: number;
  hasScore: boolean;
  hasRugged: boolean;
  hasRisks: boolean;
  hasTotalHolders: boolean;
  hasTotalMarketLiquidity: boolean;
  topLevelMintAuthority: 'null' | 'set' | 'missing';
  scoreNormalised: number | null;
  rugged: boolean | null;
  errorText: string | null;
};

const probeRugcheck = async (mint: string): Promise<ProbeSummary> => {
  try {
    const res = await fetch(`${RUGCHECK_API_BASE_URL}/tokens/${mint}/report`, {
      signal: AbortSignal.timeout(RUGCHECK_PROBE_TIMEOUT_MS),
    });
    const body = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    const errText =
      parsed !== null && typeof parsed['error'] === 'string' ? (parsed['error'] as string) : null;
    const hasScore = parsed !== null && typeof parsed['score_normalised'] === 'number';
    const hasRugged = parsed !== null && typeof parsed['rugged'] === 'boolean';
    const hasRisks = parsed !== null && Array.isArray(parsed['risks']);
    const hasTotalHolders = parsed !== null && typeof parsed['totalHolders'] === 'number';
    const hasTotalMarketLiquidity =
      parsed !== null && typeof parsed['totalMarketLiquidity'] === 'number';
    const ma = parsed === null ? undefined : parsed['mintAuthority'];
    const topLevelMintAuthority: 'null' | 'set' | 'missing' =
      parsed === null
        ? 'missing'
        : !('mintAuthority' in parsed)
          ? 'missing'
          : ma === null
            ? 'null'
            : 'set';
    return {
      status: res.status,
      bodySize: body.length,
      hasScore,
      hasRugged,
      hasRisks,
      hasTotalHolders,
      hasTotalMarketLiquidity,
      topLevelMintAuthority,
      scoreNormalised: hasScore ? (parsed?.['score_normalised'] as number) : null,
      rugged: hasRugged ? (parsed?.['rugged'] as boolean) : null,
      errorText: errText,
    };
  } catch (e) {
    return {
      status: 'network-error',
      bodySize: 0,
      hasScore: false,
      hasRugged: false,
      hasRisks: false,
      hasTotalHolders: false,
      hasTotalMarketLiquidity: false,
      topLevelMintAuthority: 'missing',
      scoreNormalised: null,
      rugged: null,
      errorText: e instanceof Error ? e.message : String(e),
    };
  }
};

const fmtMs = (ms: number): string => {
  if (ms < 1000) return `${ms.toString().padStart(5)}ms`;
  return `${(ms / 1000).toFixed(2).padStart(6)}s`;
};

const fmtProbe = (p: ProbeSummary): string => {
  if (p.status === 'network-error') return `rugcheck NET_ERR (${p.errorText ?? ''})`;
  const isFull = p.hasScore && p.hasRugged && p.hasRisks && p.hasTotalHolders;
  const flag = isFull ? 'FULL' : p.status === 200 ? 'PARTIAL' : '----';
  const errSuffix = p.errorText !== null ? ` err="${p.errorText}"` : '';
  const scoreSuffix = p.scoreNormalised !== null ? ` normalised=${p.scoreNormalised}` : '';
  const ruggedSuffix = p.rugged !== null ? ` rugged=${p.rugged}` : '';
  return `rugcheck ${p.status} ${flag} size=${p.bodySize}${scoreSuffix}${ruggedSuffix}${errSuffix}`;
};

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  if (cfg.kind === 'err') {
    console.error('config load failed:', cfg.error.issues);
    process.exit(1);
  }
  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${cfg.value.HELIUS_API_KEY}`;
  const logger = createLogger({ level: 'warn', isDevelopment: true });
  const clock = createSystemClock();

  console.log(`waiting for a fresh Pump.fun create event (timeout ${CAPTURE_TIMEOUT_MS}ms)...`);

  const captureBus = createEventBus<EventMap>();
  const captureCtrl = new AbortController();
  const captureTimer = setTimeout(() => captureCtrl.abort(), CAPTURE_TIMEOUT_MS);

  const captureAdapter = createHeliusAdapter({
    source: createKitSubscriptionSource(wsUrl),
    clock,
    logger,
    publishLog: (e) => captureBus.publish('rawProgramLogReceived', e),
  });

  const adapterPromise = captureAdapter
    .start(PUMP_FUN_PROGRAM_ID, { signal: captureCtrl.signal })
    .catch((err) => {
      if (!captureCtrl.signal.aborted) console.error('capture adapter failed:', err);
    });

  let captured: { mint: string; signature: string; detectedAtMs: number } | null = null;
  const stream = captureBus.iterate('rawProgramLogReceived', { signal: captureCtrl.signal });
  for await (const event of stream) {
    const token = parsePumpfunCreate(event, {
      internalId: randomUUID(),
      detectedAt: new Date(),
    });
    if (token === null) continue;
    captured = { mint: token.mint, signature: event.signature, detectedAtMs: Date.now() };
    captureCtrl.abort();
    break;
  }
  clearTimeout(captureTimer);
  await adapterPromise;

  if (captured === null) {
    console.log('no create event captured in window');
    process.exit(2);
  }

  console.log(`\n=== Captured fresh token ===`);
  console.log(`mint:      ${captured.mint}`);
  console.log(`signature: ${captured.signature}`);
  console.log(`detected:  +0ms (t0)\n`);

  const probeAtCapture = await probeRugcheck(captured.mint);
  const captureProbeMs = Date.now() - captured.detectedAtMs;
  console.log(`+${fmtMs(captureProbeMs)}  baseline      ${fmtProbe(probeAtCapture)}\n`);

  console.log(
    `subscribing to mint's logs for up to ${OBSERVATION_WINDOW_MS / 1000}s or ${MAX_EVENTS} events...\n`,
  );

  const mintBus = createEventBus<EventMap>();
  const mintCtrl = new AbortController();
  const observationTimer = setTimeout(() => mintCtrl.abort(), OBSERVATION_WINDOW_MS);

  const mintAdapter = createHeliusAdapter({
    source: createKitSubscriptionSource(wsUrl),
    clock,
    logger,
    publishLog: (e) => mintBus.publish('rawProgramLogReceived', e),
  });

  const mintAdapterPromise = mintAdapter
    .start(captured.mint, { signal: mintCtrl.signal })
    .catch((err) => {
      if (!mintCtrl.signal.aborted) console.error('mint adapter failed:', err);
    });

  let tradeCount = 0;
  let eventCount = 0;
  let firstFullProbeAt: number | null = null;
  const mintStream = mintBus.iterate('rawProgramLogReceived', { signal: mintCtrl.signal });

  for await (const event of mintStream) {
    if (eventCount >= MAX_EVENTS) break;
    const parsed = parsePumpfunActivityEvents(event);
    if (parsed.length === 0) continue;
    for (const item of parsed) {
      if (mintCtrl.signal.aborted) break;
      eventCount++;
      const t = Date.now() - captured.detectedAtMs;
      if (item.kind === 'trade') {
        tradeCount++;
        const trade = item.data;
        console.log(
          `+${fmtMs(t)}  trade#${tradeCount.toString().padStart(2)}    isBuy=${trade.isBuy ? 'Y' : 'N'} solL=${trade.solAmount.toString().padStart(13)} user=${trade.user.slice(0, 6)}..${trade.user.slice(-4)}`,
        );
        const probe = await probeRugcheck(captured.mint);
        const probeT = Date.now() - captured.detectedAtMs;
        const isFull = probe.hasScore && probe.hasRugged && probe.hasRisks && probe.hasTotalHolders;
        if (isFull && firstFullProbeAt === null) firstFullProbeAt = probeT;
        console.log(`+${fmtMs(probeT)}             ${fmtProbe(probe)}`);
      } else {
        console.log(`+${fmtMs(t)}  complete       graduated`);
      }
    }
    if (eventCount >= MAX_EVENTS) break;
  }
  clearTimeout(observationTimer);
  mintCtrl.abort();
  await mintAdapterPromise;

  console.log(`\n=== Observation summary ===`);
  console.log(`total parsed events: ${eventCount} (trades: ${tradeCount})`);
  console.log(
    `first FULL rugcheck response: ${firstFullProbeAt !== null ? `+${fmtMs(firstFullProbeAt)}` : 'never'}`,
  );
};

await main();
