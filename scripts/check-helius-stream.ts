import { createSystemClock } from '../src/infrastructure/clock/clock.js';
import { loadConfig } from '../src/infrastructure/config/configLoader.js';
import { createHeliusAdapter } from '../src/infrastructure/helius/heliusAdapter.js';
import { createKitSubscriptionSource } from '../src/infrastructure/helius/kitSubscriptionSource.js';
import { createLogger } from '../src/infrastructure/logger/logger.js';

const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
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

  const adapter = createHeliusAdapter({
    source: createKitSubscriptionSource(wsUrl),
    clock: createSystemClock(),
    logger,
  });

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), RUN_DURATION_MS);

  logger.info(
    { programId: PUMP_FUN_PROGRAM_ID, durationMs: RUN_DURATION_MS },
    'subscribing to Pump.fun program logs',
  );

  let count = 0;
  try {
    for await (const event of adapter.subscribeToProgramLogs(PUMP_FUN_PROGRAM_ID, {
      signal: ctrl.signal,
    })) {
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
  } catch (err) {
    if (!ctrl.signal.aborted) {
      logger.error({ err }, 'subscription failed unexpectedly');
      process.exit(1);
    }
  }

  logger.info({ totalEvents: count }, 'subscription ended cleanly');
};

await main();
