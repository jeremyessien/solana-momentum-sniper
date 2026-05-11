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
  readonly logger: Logger;
  readonly signal: AbortSignal;
};

export const wireTelegramNotifications = (deps: WireTelegramNotificationsDeps): void => {
  if (deps.signal.aborted) return;

  const onDetected = (token: DetectedToken): void => {
    void deps.telegramClient.sendMessage(formatNewTokenLaunchDetected(token));
  };

  const onAnalyzed = (analysis: TokenWithFullContext): void => {
    void deps.telegramClient.sendMessage(formatTokenAnalysisCompleted(analysis));
  };

  const onClosed = (closed: TokenTrackingClosed): void => {
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
