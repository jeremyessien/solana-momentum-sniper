import type { DetectedToken } from '../../shared/detectedToken.js';
import type { StrategyEvaluationResult } from '../../shared/strategyEvaluationResult.js';
import type { TokenTrackingClosed } from '../../shared/tokenTrackingClosed.js';
import type { TokenTradeObserved } from '../../shared/tokenTradeObserved.js';
import type { TokenWithFullContext } from '../../shared/tokenWithFullContext.js';
import type { Logger } from '../logger/logger.js';
import type { EventStore } from './eventStore.js';

export type SubscribeToDetectedTokens = (handler: (token: DetectedToken) => void) => () => void;

export type SubscribeToAnalysisCompleted = (
  handler: (analysis: TokenWithFullContext) => void,
) => () => void;

export type SubscribeToTradeObserved = (handler: (trade: TokenTradeObserved) => void) => () => void;

export type SubscribeToTrackingClosed = (
  handler: (closed: TokenTrackingClosed) => void,
) => () => void;

export type SubscribeToStrategyDecision = (
  handler: (decision: StrategyEvaluationResult) => void,
) => () => void;

export type WireStoreDeps = {
  readonly subscribeToDetectedTokens: SubscribeToDetectedTokens;
  readonly subscribeToAnalysisCompleted: SubscribeToAnalysisCompleted;
  readonly subscribeToTradeObserved: SubscribeToTradeObserved;
  readonly subscribeToTrackingClosed: SubscribeToTrackingClosed;
  readonly subscribeToStrategyDecision: SubscribeToStrategyDecision;
  readonly eventStore: EventStore;
  readonly logger: Logger;
  readonly signal: AbortSignal;
};

export const wireStore = (deps: WireStoreDeps): void => {
  if (deps.signal.aborted) return;

  const recordSafely = <E>(
    fn: (event: E) => void,
    event: E,
    eventLabel: string,
    tokenId: string,
  ): void => {
    try {
      fn(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error(
        { err: message, eventLabel, tokenInternalId: tokenId },
        'store write failed',
      );
    }
  };

  const onDetected = (token: DetectedToken): void => {
    recordSafely(deps.eventStore.recordDetection, token, 'detection', token.internalId);
  };

  const onAnalyzed = (analysis: TokenWithFullContext): void => {
    recordSafely(
      deps.eventStore.recordAnalysisCompleted,
      analysis,
      'analysis',
      analysis.detected.internalId,
    );
  };

  const onTrade = (trade: TokenTradeObserved): void => {
    recordSafely(deps.eventStore.recordTradeObserved, trade, 'trade', trade.tokenInternalId);
  };

  const onClosed = (closed: TokenTrackingClosed): void => {
    recordSafely(
      deps.eventStore.recordTrackingClosed,
      closed,
      'trackingClosed',
      closed.tokenInternalId,
    );
  };

  const onStrategyDecision = (decision: StrategyEvaluationResult): void => {
    recordSafely(
      deps.eventStore.recordStrategyDecision,
      decision,
      'strategyDecision',
      decision.candidate.detected.internalId,
    );
  };

  const unsubscribeDetected = deps.subscribeToDetectedTokens(onDetected);
  const unsubscribeAnalyzed = deps.subscribeToAnalysisCompleted(onAnalyzed);
  const unsubscribeTrade = deps.subscribeToTradeObserved(onTrade);
  const unsubscribeClosed = deps.subscribeToTrackingClosed(onClosed);
  const unsubscribeStrategy = deps.subscribeToStrategyDecision(onStrategyDecision);

  const cleanup = (): void => {
    unsubscribeDetected();
    unsubscribeAnalyzed();
    unsubscribeTrade();
    unsubscribeClosed();
    unsubscribeStrategy();
  };

  deps.signal.addEventListener('abort', cleanup, { once: true });
};
