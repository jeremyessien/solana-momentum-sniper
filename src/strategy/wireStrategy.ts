import type { Clock } from '../infrastructure/clock/clock.js';
import type { Logger } from '../infrastructure/logger/logger.js';
import type {
  StrategyDecision,
  StrategyEvaluationResult,
} from '../shared/strategyEvaluationResult.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';
import {
  DATA_COLLECTION_STRATEGY_ID,
  DATA_COLLECTION_THRESHOLDS,
  evaluateDataCollectionStrategy,
} from './dataCollectionStrategy.js';

export type SubscribeToAnalysisCompleted = (
  handler: (analysis: TokenWithFullContext) => void,
) => () => void;

export type PublishStrategyDecision = (decision: StrategyEvaluationResult) => void;

export type WireStrategyDeps = {
  readonly subscribeToAnalysisCompleted: SubscribeToAnalysisCompleted;
  readonly publishStrategyDecision: PublishStrategyDecision;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly signal: AbortSignal;
};

export const wireStrategy = (deps: WireStrategyDeps): void => {
  if (deps.signal.aborted) return;

  const handler = (analysis: TokenWithFullContext): void => {
    let decision: StrategyDecision;
    try {
      decision = evaluateDataCollectionStrategy(analysis, DATA_COLLECTION_THRESHOLDS);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      deps.logger.error(
        {
          err: message,
          internalId: analysis.detected.internalId,
          mint: analysis.detected.mint,
        },
        'strategy evaluation threw',
      );
      return;
    }

    const result: StrategyEvaluationResult = {
      strategyId: DATA_COLLECTION_STRATEGY_ID,
      candidate: analysis,
      thresholds: DATA_COLLECTION_THRESHOLDS,
      decision,
      evaluatedAt: deps.clock.now(),
    };

    deps.logger.info(
      {
        internalId: analysis.detected.internalId,
        mint: analysis.detected.mint,
        verdict: decision.kind,
      },
      'strategy decision recorded',
    );
    deps.publishStrategyDecision(result);
  };

  const unsubscribe = deps.subscribeToAnalysisCompleted(handler);
  deps.signal.addEventListener('abort', unsubscribe, { once: true });
};
