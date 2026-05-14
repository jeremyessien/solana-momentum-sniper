import type { Clock } from '../infrastructure/clock/clock.js';
import type { Logger } from '../infrastructure/logger/logger.js';
import type { TelegramClient } from '../infrastructure/telegram/telegramClient.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import type { TokenTrackingClosed } from '../shared/tokenTrackingClosed.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';
import {
  formatNewTokenLaunchDetected,
  formatTokenAnalysisCompleted,
  formatTokenTrackingClosed,
} from './telegramMessages.js';

const DEFAULT_DEDUP_WINDOW_MS = 30_000;
const DEDUP_MAX_ENTRIES = 1_000;

export type SubscribeToDetectedTokens = (handler: (token: DetectedToken) => void) => () => void;

export type SubscribeToAnalysisCompleted = (
  handler: (analysis: TokenWithFullContext) => void,
) => () => void;

export type SubscribeToTrackingClosed = (
  handler: (closed: TokenTrackingClosed) => void,
) => () => void;

export type WireTelegramNotificationsDeps = {
  readonly subscribeToDetectedTokens: SubscribeToDetectedTokens;
  readonly subscribeToAnalysisCompleted: SubscribeToAnalysisCompleted;
  readonly subscribeToTrackingClosed: SubscribeToTrackingClosed;
  readonly telegramClient: TelegramClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly dedupWindowMs?: number;
};

export const wireTelegramNotifications = (deps: WireTelegramNotificationsDeps): void => {
  if (deps.signal.aborted) return;

  const dedupWindowMs = deps.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const recentKeys = new Map<string, number>();

  const isDuplicate = (key: string): boolean => {
    const now = deps.clock.monotonicMs();
    for (const [k, ts] of recentKeys) {
      if (now - ts > dedupWindowMs) recentKeys.delete(k);
    }
    if (recentKeys.has(key)) return true;
    recentKeys.set(key, now);
    while (recentKeys.size > DEDUP_MAX_ENTRIES) {
      const oldest = recentKeys.keys().next().value;
      if (oldest === undefined) break;
      recentKeys.delete(oldest);
    }
    return false;
  };

  const onDetected = (token: DetectedToken): void => {
    if (isDuplicate(`detection:${token.mint}`)) {
      deps.logger.debug({ mint: token.mint }, 'skipping duplicate telegram detection');
      return;
    }
    void deps.telegramClient.sendMessage(formatNewTokenLaunchDetected(token));
  };

  const onAnalyzed = (analysis: TokenWithFullContext): void => {
    if (isDuplicate(`analysis:${analysis.detected.mint}`)) {
      deps.logger.debug({ mint: analysis.detected.mint }, 'skipping duplicate telegram analysis');
      return;
    }
    void deps.telegramClient.sendMessage(formatTokenAnalysisCompleted(analysis));
  };

  const onClosed = (closed: TokenTrackingClosed): void => {
    if (isDuplicate(`closed:${closed.mint}`)) {
      deps.logger.debug({ mint: closed.mint }, 'skipping duplicate telegram tracking-closed');
      return;
    }
    void deps.telegramClient.sendMessage(formatTokenTrackingClosed(closed));
  };

  const unsubscribeDetected = deps.subscribeToDetectedTokens(onDetected);
  const unsubscribeAnalyzed = deps.subscribeToAnalysisCompleted(onAnalyzed);
  const unsubscribeClosed = deps.subscribeToTrackingClosed(onClosed);

  const cleanup = (): void => {
    unsubscribeDetected();
    unsubscribeAnalyzed();
    unsubscribeClosed();
  };

  deps.signal.addEventListener('abort', cleanup, { once: true });
};
