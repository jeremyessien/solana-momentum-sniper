import { randomUUID } from 'node:crypto';
import { parsePumpfunActivityEvents } from '../src/activity/pumpfunTradeParser.js';
import { parsePumpfunCreate } from '../src/detection/pumpfunCreateParser.js';
import { wireEnrichment } from '../src/enrichment/wireEnrichment.js';
import { createSystemClock } from '../src/infrastructure/clock/clock.js';
import { loadConfig } from '../src/infrastructure/config/configLoader.js';
import { createEventBus } from '../src/infrastructure/eventBus/eventBus.js';
import { createHeliusAdapter } from '../src/infrastructure/helius/heliusAdapter.js';
import { createKitSubscriptionSource } from '../src/infrastructure/helius/kitSubscriptionSource.js';
import { createLogger } from '../src/infrastructure/logger/logger.js';
import { createRugCheckClient } from '../src/infrastructure/rugcheck/rugCheckClient.js';
import type { DetectedToken } from '../src/shared/detectedToken.js';
import type { EventMap } from '../src/shared/eventMap.js';
import { PUMP_FUN_PROGRAM_ID } from '../src/shared/launchpadPrograms.js';
import type { TokenTrackingClosed } from '../src/shared/tokenTrackingClosed.js';
import type { TokenTradeObserved } from '../src/shared/tokenTradeObserved.js';
import type { TokenWithFullContext } from '../src/shared/tokenWithFullContext.js';

const CAPTURE_TIMEOUT_MS = 30_000;
const OBSERVATION_WINDOW_MS = 60_000;
const MAX_TRADES = 10;

const fmt = (ms: number): string =>
  ms < 1000 ? `${ms.toString().padStart(5)}ms` : `${(ms / 1000).toFixed(2).padStart(6)}s`;

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
  const captureAdapterPromise = captureAdapter
    .start(PUMP_FUN_PROGRAM_ID, { signal: captureCtrl.signal })
    .catch((err) => {
      if (!captureCtrl.signal.aborted) console.error('capture adapter failed:', err);
    });

  let captured: { token: DetectedToken; detectedAtMs: number } | null = null;
  const stream = captureBus.iterate('rawProgramLogReceived', { signal: captureCtrl.signal });
  for await (const event of stream) {
    const token = parsePumpfunCreate(event, {
      internalId: randomUUID(),
      detectedAt: new Date(),
    });
    if (token === null) continue;
    captured = { token, detectedAtMs: Date.now() };
    captureCtrl.abort();
    break;
  }
  clearTimeout(captureTimer);
  await captureAdapterPromise;

  if (captured === null) {
    console.log('no create event captured');
    process.exit(2);
  }

  const t0 = captured.detectedAtMs;
  console.log(`\n=== captured ===`);
  console.log(`mint:        ${captured.token.mint}`);
  console.log(`internalId:  ${captured.token.internalId}`);
  console.log();

  const verifyBus = createEventBus<EventMap>();
  const verifyCtrl = new AbortController();
  const observationTimer = setTimeout(() => verifyCtrl.abort(), OBSERVATION_WINDOW_MS);

  const rugcheck = createRugCheckClient({ clock });
  const published: { atMs: number; analysis: TokenWithFullContext }[] = [];

  wireEnrichment({
    subscribeToDetectedTokens: (h) => verifyBus.subscribe('newTokenLaunchDetected', h),
    subscribeToTradeObserved: (h) => verifyBus.subscribe('tokenTradeObserved', h),
    subscribeToTrackingClosed: (h) => verifyBus.subscribe('tokenTrackingClosed', h),
    publishAnalysisCompleted: (a) => {
      const atMs = Date.now() - t0;
      published.push({ atMs, analysis: a });
      console.log(
        `+${fmt(atMs)}  ANALYSIS  rugcheck.kind=${a.rugcheck.kind}${
          a.rugcheck.kind === 'ok'
            ? ` normalised=${a.rugcheck.value.scoreNormalised} rugged=${a.rugcheck.value.rugged}`
            : ` reason=${a.rugcheck.error.kind}`
        }`,
      );
    },
    rugcheckClient: rugcheck,
    clock,
    logger,
    signal: verifyCtrl.signal,
  });

  verifyBus.publish('newTokenLaunchDetected', captured.token);
  await new Promise((r) => setImmediate(r));

  console.log(`+${fmt(Date.now() - t0)}  DETECTED  (cached, no rugcheck yet)\n`);

  const mintAdapter = createHeliusAdapter({
    source: createKitSubscriptionSource(wsUrl),
    clock,
    logger,
    publishLog: (e) => verifyBus.publish('rawProgramLogReceived', e),
  });
  const mintAdapterPromise = mintAdapter
    .start(captured.token.mint, { signal: verifyCtrl.signal })
    .catch((err) => {
      if (!verifyCtrl.signal.aborted) console.error('mint adapter failed:', err);
    });

  let tradeCount = 0;
  const mintStream = verifyBus.iterate('rawProgramLogReceived', { signal: verifyCtrl.signal });
  for await (const event of mintStream) {
    if (tradeCount >= MAX_TRADES) break;
    const parsed = parsePumpfunActivityEvents(event);
    for (const item of parsed) {
      if (item.kind !== 'trade' || verifyCtrl.signal.aborted) continue;
      tradeCount++;
      const t = Date.now() - t0;
      const trade: TokenTradeObserved = {
        tokenInternalId: captured.token.internalId,
        mint: item.data.mint,
        trader: item.data.user,
        isBuy: item.data.isBuy,
        solAmount: item.data.solAmount,
        tokenAmount: item.data.tokenAmount,
        virtualSolReserves: item.data.virtualSolReserves,
        virtualTokenReserves: item.data.virtualTokenReserves,
        slot: event.slot,
        signature: event.signature,
        observedAt: new Date(),
        pumpFunTimestamp: item.data.timestamp,
      };
      console.log(`+${fmt(t)}  TRADE#${tradeCount.toString().padStart(2)}    isBuy=${trade.isBuy ? 'Y' : 'N'}`);
      verifyBus.publish('tokenTradeObserved', trade);
      await new Promise((r) => setImmediate(r));
    }
    if (tradeCount >= MAX_TRADES) break;
  }

  await new Promise((r) => setTimeout(r, 3_000));

  if (published.length === 0) {
    console.log(`\nNo trades observed in window — firing synthetic tracking_closed`);
    const closed: TokenTrackingClosed = {
      tokenInternalId: captured.token.internalId,
      mint: captured.token.mint,
      closedAt: new Date(),
      reason: 'timeout',
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      uniqueTraders: 0,
      creatorTraded: false,
      firstTradeSlot: null,
      lastTradeSlot: null,
    };
    verifyBus.publish('tokenTrackingClosed', closed);
    await new Promise((r) => setImmediate(r));
  }

  clearTimeout(observationTimer);
  verifyCtrl.abort();
  await mintAdapterPromise;

  console.log(`\n=== summary ===`);
  console.log(`trades observed:   ${tradeCount}`);
  console.log(`analyses published: ${published.length}`);
  for (const p of published) {
    console.log(
      `  +${fmt(p.atMs)}  rugcheck.kind=${p.analysis.rugcheck.kind}${
        p.analysis.rugcheck.kind === 'ok'
          ? ` normalised=${p.analysis.rugcheck.value.scoreNormalised}`
          : ` reason=${p.analysis.rugcheck.error.kind}`
      }`,
    );
  }
};

await main();