import { randomUUID } from 'node:crypto';
import { wireActivityTracker } from './activity/wireActivityTracker.js';
import { wireDetection } from './detection/wireDetection.js';
import { wireEnrichment } from './enrichment/wireEnrichment.js';
import { createSystemClock } from './infrastructure/clock/clock.js';
import { loadConfig } from './infrastructure/config/configLoader.js';
import { createEventBus } from './infrastructure/eventBus/eventBus.js';
import { createHeliusAdapter } from './infrastructure/helius/heliusAdapter.js';
import { createKitSubscriptionSource } from './infrastructure/helius/kitSubscriptionSource.js';
import { createLogger } from './infrastructure/logger/logger.js';
import { createRugCheckClient } from './infrastructure/rugcheck/rugCheckClient.js';
import {
  createGrammyBotApi,
  createTelegramClient,
} from './infrastructure/telegram/telegramClient.js';
import { wireTelegramNotifications } from './interface/wireTelegramNotifications.js';
import type { EventMap } from './shared/eventMap.js';
import { PUMP_FUN_PROGRAM_ID } from './shared/launchpadPrograms.js';

const SHUTDOWN_GOODBYE_TIMEOUT_MS = 5_000;

const main = async (): Promise<void> => {
  const cfgResult = loadConfig();
  if (cfgResult.kind === 'err') {
    console.error('config load failed:', cfgResult.error.issues);
    process.exit(1);
  }
  const config = cfgResult.value;

  const logger = createLogger({
    level: config.LOG_LEVEL,
    isDevelopment: config.NODE_ENV !== 'production',
  });

  logger.info('moonscout starting');

  const clock = createSystemClock();
  const eventBus = createEventBus<EventMap>();

  const ctrl = new AbortController();
  const handleSignal = (signal: string): void => {
    if (ctrl.signal.aborted) return;
    logger.info({ signal }, 'shutdown signal received');
    ctrl.abort();
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  const recipientChatId = config.TELEGRAM_USER_ID_WHITELIST[0];
  if (recipientChatId === undefined) {
    logger.error('TELEGRAM_USER_ID_WHITELIST has no entries after parsing');
    process.exit(1);
  }

  const telegramBotApi = createGrammyBotApi(config.TELEGRAM_BOT_TOKEN);
  const telegramClient = createTelegramClient({
    botApi: telegramBotApi,
    recipientChatId,
    logger,
  });

  let botUsername: string;
  try {
    botUsername = await telegramClient.getBotUsername();
    logger.info({ botUsername }, 'telegram bot identity verified');
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'telegram bot token check failed; exiting',
    );
    process.exit(1);
  }

  await telegramClient.sendMessage(`🟢 <b>moonscout started</b>\n<b>Bot:</b> @${botUsername}`);

  const rugcheckClient = createRugCheckClient({ clock });

  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
  const adapter = createHeliusAdapter({
    source: createKitSubscriptionSource(wsUrl),
    clock,
    logger,
    publishLog: (event) => eventBus.publish('rawProgramLogReceived', event),
  });

  wireDetection({
    subscribeToRawLogs: (h) => eventBus.subscribe('rawProgramLogReceived', h),
    publishToken: (t) => eventBus.publish('newTokenLaunchDetected', t),
    clock,
    logger,
    idGenerator: () => randomUUID(),
    signal: ctrl.signal,
  });

  wireEnrichment({
    subscribeToDetectedTokens: (h) => eventBus.subscribe('newTokenLaunchDetected', h),
    publishAnalysisCompleted: (a) => eventBus.publish('tokenAnalysisCompleted', a),
    rugcheckClient,
    clock,
    logger,
    signal: ctrl.signal,
  });

  wireActivityTracker({
    subscribeToDetectedTokens: (h) => eventBus.subscribe('newTokenLaunchDetected', h),
    subscribeToRawLogs: (h) => eventBus.subscribe('rawProgramLogReceived', h),
    publishTradeObserved: (e) => eventBus.publish('tokenTradeObserved', e),
    publishTrackingClosed: (e) => eventBus.publish('tokenTrackingClosed', e),
    clock,
    logger,
    signal: ctrl.signal,
  });

  wireTelegramNotifications({
    subscribeToDetectedTokens: (h) => eventBus.subscribe('newTokenLaunchDetected', h),
    subscribeToAnalysisCompleted: (h) => eventBus.subscribe('tokenAnalysisCompleted', h),
    subscribeToTrackingClosed: (h) => eventBus.subscribe('tokenTrackingClosed', h),
    telegramClient,
    logger,
    signal: ctrl.signal,
  });

  logger.info({ programId: PUMP_FUN_PROGRAM_ID }, 'starting Helius adapter — pipeline live');

  try {
    await adapter.start(PUMP_FUN_PROGRAM_ID, { signal: ctrl.signal });
  } catch (err) {
    if (!ctrl.signal.aborted) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'adapter failed unexpectedly',
      );
    }
  }

  logger.info('shutting down');
  await Promise.race([
    telegramClient.sendMessage('🔴 <b>moonscout stopped</b>'),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GOODBYE_TIMEOUT_MS)),
  ]);
  logger.info('shutdown complete');
};

main().catch((err: unknown) => {
  console.error('fatal error in main:', err);
  process.exit(1);
});
