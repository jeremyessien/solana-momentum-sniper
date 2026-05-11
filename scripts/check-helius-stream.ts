import { createSystemClock } from '../src/infrastructure/clock/clock.js';
import { loadConfig } from '../src/infrastructure/config/configLoader.js';
import { createEventBus } from '../src/infrastructure/eventBus/eventBus.js';
import { createHeliusAdapter } from '../src/infrastructure/helius/heliusAdapter.js';
import { createKitSubscriptionSource } from '../src/infrastructure/helius/kitSubscriptionSource.js';
import { createLogger } from '../src/infrastructure/logger/logger.js';
import type { EventMap } from '../src/shared/eventMap.js';
import { PUMP_FUN_PROGRAM_ID } from '../src/shared/launchpadPrograms.js';

const RUN_DURATION_MS = 30_000;

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
  setTimeout(() => ctrl.abort(), RUN_DURATION_MS);

  logger.info(
    { programId: PUMP_FUN_PROGRAM_ID, durationMs: RUN_DURATION_MS },
    'subscribing to Pump.fun program logs',
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

  let count = 0;
  for await (const event of stream) {
    count++;
    logger.info(
      {
        signature: event.signature,
        slot: event.slot.toString(),
        logCount: event.logs.length,
        err: event.err,
      },
      'event received',
    );
  }

  await adapterPromise;
  logger.info({ totalEvents: count }, 'subscription ended cleanly');
};

await main();
