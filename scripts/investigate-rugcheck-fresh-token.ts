import { randomUUID } from 'node:crypto';
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
const PROBE_DELAYS_MS = [0, 15_000, 45_000];
const PROBE_TIMEOUT_MS = 5_000;
const BODY_PREVIEW_BYTES = 2_000;

const probeRugcheck = async (
  mint: string,
): Promise<{ status: number; preview: string; bodySize: number }> => {
  const res = await fetch(`${RUGCHECK_API_BASE_URL}/tokens/${mint}/report`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const body = await res.text();
  return { status: res.status, preview: body.slice(0, BODY_PREVIEW_BYTES), bodySize: body.length };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  if (cfg.kind === 'err') {
    console.error('config load failed:', cfg.error.issues);
    process.exit(1);
  }
  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${cfg.value.HELIUS_API_KEY}`;
  const logger = createLogger({ level: 'warn', isDevelopment: true });
  const eventBus = createEventBus<EventMap>();
  const adapter = createHeliusAdapter({
    source: createKitSubscriptionSource(wsUrl),
    clock: createSystemClock(),
    logger,
    publishLog: (e) => eventBus.publish('rawProgramLogReceived', e),
  });

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), CAPTURE_TIMEOUT_MS);

  const adapterPromise = adapter
    .start(PUMP_FUN_PROGRAM_ID, { signal: ctrl.signal })
    .catch((err) => {
      if (!ctrl.signal.aborted) console.error('adapter failed:', err);
    });

  console.log(`waiting for a fresh Pump.fun create event (timeout ${CAPTURE_TIMEOUT_MS}ms)...`);

  const stream = eventBus.iterate('rawProgramLogReceived', { signal: ctrl.signal });
  let captured: { mint: string; signature: string; detectedAt: number } | null = null;

  for await (const event of stream) {
    const token = parsePumpfunCreate(event, {
      internalId: randomUUID(),
      detectedAt: new Date(),
    });
    if (token === null) continue;
    captured = { mint: token.mint, signature: event.signature, detectedAt: Date.now() };
    ctrl.abort();
    break;
  }
  await adapterPromise;

  if (captured === null) {
    console.log('no create event captured in window');
    process.exit(2);
  }

  console.log(`\n=== Captured fresh token ===`);
  console.log(`mint:      ${captured.mint}`);
  console.log(`signature: ${captured.signature}`);

  for (const delay of PROBE_DELAYS_MS) {
    const waitNeeded = captured.detectedAt + delay - Date.now();
    if (waitNeeded > 0) await sleep(waitNeeded);
    const t = Date.now() - captured.detectedAt;
    try {
      const r = await probeRugcheck(captured.mint);
      console.log(
        `\n+${t}ms  status=${r.status}  bodySize=${r.bodySize}\n${r.preview}${r.bodySize > BODY_PREVIEW_BYTES ? '...[truncated]' : ''}`,
      );
    } catch (err) {
      console.log(`+${t}ms  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
};

await main();
