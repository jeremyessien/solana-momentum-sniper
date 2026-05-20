import type {
  PassReasonCode,
  StrategyDecision,
  StrategyId,
  ThresholdsSnapshot,
  WatchReasonCode,
} from '../shared/strategyEvaluationResult.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';

export const DATA_COLLECTION_STRATEGY_ID: StrategyId = 'data-collection';

export const DATA_COLLECTION_THRESHOLDS: ThresholdsSnapshot = {
  enterMaxScoreNormalised: 30,
  enterMaxTopHolderPercent: 20,
  watchMaxScoreNormalised: 60,
  watchMaxTopHolderPercent: 30,
};

export const evaluateDataCollectionStrategy = (
  candidate: TokenWithFullContext,
  thresholds: ThresholdsSnapshot,
): StrategyDecision => {
  if (candidate.rugcheck.kind === 'err') {
    return { kind: 'pass', reasons: ['rugcheck_failed'] };
  }
  const snapshot = candidate.rugcheck.value;

  const largestHolderPct = Math.max(0, ...snapshot.topHolders.map((h) => h.pct));

  const hardFailures: PassReasonCode[] = [];
  if (snapshot.rugged) hardFailures.push('rugged');
  if (snapshot.mintAuthority !== null) hardFailures.push('mint_authority_active');
  if (snapshot.freezeAuthority !== null) hardFailures.push('freeze_authority_active');
  if (largestHolderPct > thresholds.watchMaxTopHolderPercent)
    hardFailures.push('top_holder_excessive');
  if (snapshot.scoreNormalised > thresholds.watchMaxScoreNormalised)
    hardFailures.push('score_too_risky');

  if (hardFailures.length > 0) {
    return { kind: 'pass', reasons: hardFailures as [PassReasonCode, ...PassReasonCode[]] };
  }

  const enterEligible =
    snapshot.scoreNormalised <= thresholds.enterMaxScoreNormalised &&
    largestHolderPct <= thresholds.enterMaxTopHolderPercent;

  if (enterEligible) {
    return { kind: 'enter' };
  }

  const watchReasons: WatchReasonCode[] = [];
  if (snapshot.scoreNormalised > thresholds.enterMaxScoreNormalised) {
    watchReasons.push('score_borderline');
  }
  if (largestHolderPct > thresholds.enterMaxTopHolderPercent) {
    watchReasons.push('holder_concentration_borderline');
  }

  if (watchReasons.length === 0) {
    // Invariant: hard checks passed and not enter-eligible → at least one
    // borderline reason must fire. Reaching here is a logic bug.
    throw new Error('data-collection: watch branch reached with no reasons');
  }
  return { kind: 'watch', reasons: watchReasons as [WatchReasonCode, ...WatchReasonCode[]] };
};
