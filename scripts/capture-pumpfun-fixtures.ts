import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSystemClock } from '../src/infrastructure/clock/clock.js';
import { loadConfig } from '../src/infrastructure/config/configLoader.js';
import { createEventBus } from '../src/infrastructure/eventBus/eventBus.js';
import { createHeliusAdapter } from '../src/infrastructure/helius/heliusAdapter.js';
import { createKitSubscriptionSource } from '../src/infrastructure/helius/kitSubscriptionSource.js';
import { createLogger } from '../src/infrastructure/logger/logger.js';
import type { EventMap } from '../src/shared/eventMap.js';

const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TARGET_SAMPLE_COUNT = 2;
const MAX_DURATION_MS = 120_000;
const FIRST_INDEX = 2;

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures',
);

const main = async (): Promise<void> => {
  const result = loadConfig();
  if (result.kind === 'err') {
    console.error('Config load failed:', result.error.issues);
    process.exit(1);
  }
  const config = result.value;

  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
  const logger = createLogger({
    level: config.LOG_LEVEL,
    isDevelopment: config.NODE_ENV !== 'production',
  });

  const eventBus = createEventBus<EventMap>();
  const adapter = createHeliusAdapter({
    source: createKitSubscriptionSource(wsUrl),
    clock: createSystemClock(),
    logger,
    publishLog: (event) => eventBus.publish('rawProgramLogReceived', event),
  });

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), MAX_DURATION_MS);

  logger.info(
    { target: TARGET_SAMPLE_COUNT, maxDurationMs: MAX_DURATION_MS },
    'capturing Pump.fun create-event fixtures',
  );

  const stream = eventBus.iterate('rawProgramLogReceived', { signal: ctrl.signal });
  const adapterPromise = adapter
    .start(PUMP_FUN_PROGRAM_ID, { signal: ctrl.signal })
    .catch((err: unknown) => {
      if (!ctrl.signal.aborted) {
        logger.error({ err }, 'adapter failed unexpectedly');
        ctrl.abort();
      }
    });

  let captured = 0;
  for await (const event of stream) {
    if (event.err !== null) continue;
    const isCreate = event.logs.some(
      (l) => l === 'Program log: Instruction: CreateV2' || l === 'Program log: Instruction: Create',
    );
    if (!isCreate) continue;

    captured++;
    const idx = FIRST_INDEX + captured - 1;
    const samplePath = path.join(FIXTURES_DIR, `pumpfun-create-v2-sample-${idx}.json`);
    const payload = {
      _notes: {
        captured: new Date().toISOString(),
        purpose:
          'Additional CreateV2 capture for parser test coverage; structural assertions only.',
      },
      transaction: {
        signature: event.signature,
        slot: event.slot.toString(),
        logs: event.logs,
      },
    };
    writeFileSync(samplePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    logger.info(
      { idx, path: samplePath, signature: event.signature, slot: event.slot.toString() },
      'captured fixture',
    );

    if (captured >= TARGET_SAMPLE_COUNT) {
      ctrl.abort();
      break;
    }
  }

  await adapterPromise;
  logger.info({ captured }, 'capture ended');
};

await main();
