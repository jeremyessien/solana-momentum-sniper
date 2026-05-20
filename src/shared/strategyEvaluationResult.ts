import type { TokenWithFullContext } from './tokenWithFullContext.js';

export type StrategyId = 'data-collection';

// Thresholds are a snapshot on the wrapper (not inside reasons) so each
// parameter value is recorded once per decision. Reason codes are bare
// strings; the values that triggered them live in `candidate.rugcheck`.
export type ThresholdsSnapshot = {
  readonly enterMaxScoreNormalised: number;
  readonly enterMaxTopHolderPercent: number;
  readonly watchMaxScoreNormalised: number;
  readonly watchMaxTopHolderPercent: number;
};

export type PassReasonCode =
  | 'rugcheck_failed'
  | 'rugged'
  | 'mint_authority_active'
  | 'freeze_authority_active'
  | 'top_holder_excessive'
  | 'score_above_threshold';

export type WatchReasonCode = 'score_borderline' | 'holder_concentration_borderline';

export type StrategyDecision =
  | { readonly kind: 'pass'; readonly reasons: readonly [PassReasonCode, ...PassReasonCode[]] }
  | { readonly kind: 'watch'; readonly reasons: readonly [WatchReasonCode, ...WatchReasonCode[]] }
  | { readonly kind: 'enter' };

export type StrategyEvaluationResult = {
  readonly strategyId: StrategyId;
  readonly candidate: TokenWithFullContext;
  readonly thresholds: ThresholdsSnapshot;
  readonly decision: StrategyDecision;
  readonly evaluatedAt: Date;
};
