import type { Clock } from '../infrastructure/clock/clock.js';
import type { Logger } from '../infrastructure/logger/logger.js';
import type { RugCheckClient } from '../infrastructure/rugcheck/rugCheckClient.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';

export type SubscribeToDetectedTokens = (
  handler: (token: DetectedToken) => void | Promise<void>,
) => () => void;

export type PublishAnalysisCompleted = (analysis: TokenWithFullContext) => void;

export type WireEnrichmentDeps = {
  readonly subscribeToDetectedTokens: SubscribeToDetectedTokens;
  readonly publishAnalysisCompleted: PublishAnalysisCompleted;
  readonly rugcheckClient: RugCheckClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly signal: AbortSignal;
};

export const wireEnrichment = (deps: WireEnrichmentDeps): void => {
  if (deps.signal.aborted) return;

  const handler = async (token: DetectedToken): Promise<void> => {
    const result = await deps.rugcheckClient.fetchReport(token.mint, deps.signal);

    if (deps.signal.aborted) return;

    const analysis: TokenWithFullContext = {
      detected: token,
      analyzedAt: deps.clock.now(),
      rugcheck: result,
    };

    if (result.kind === 'ok') {
      deps.logger.info(
        {
          mint: token.mint,
          internalId: token.internalId,
          scoreNormalised: result.value.scoreNormalised,
          rugged: result.value.rugged,
          totalHolders: result.value.totalHolders,
        },
        'rugcheck analysis succeeded',
      );
    } else {
      deps.logger.warn(
        {
          mint: token.mint,
          internalId: token.internalId,
          reason: result.error.kind,
        },
        'rugcheck analysis failed',
      );
    }

    deps.publishAnalysisCompleted(analysis);
  };

  const unsubscribe = deps.subscribeToDetectedTokens(handler);
  deps.signal.addEventListener('abort', unsubscribe, { once: true });
};
