import type { Clock } from '../infrastructure/clock/clock.js';
import type { Logger } from '../infrastructure/logger/logger.js';
import type { RugCheckClient } from '../infrastructure/rugcheck/rugCheckClient.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import { err } from '../shared/result.js';
import type { RugCheckFetchError } from '../shared/rugCheckSnapshot.js';
import type { TokenTrackingClosed } from '../shared/tokenTrackingClosed.js';
import type { TokenTradeObserved } from '../shared/tokenTradeObserved.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';

const DEFAULT_COOLDOWN_MS = 1_500;

export type SubscribeToDetectedTokens = (
  handler: (token: DetectedToken) => void | Promise<void>,
) => () => void;

export type SubscribeToTradeObserved = (
  handler: (trade: TokenTradeObserved) => void | Promise<void>,
) => () => void;

export type SubscribeToTrackingClosed = (
  handler: (closed: TokenTrackingClosed) => void | Promise<void>,
) => () => void;

export type PublishAnalysisCompleted = (analysis: TokenWithFullContext) => void;

export type WireEnrichmentDeps = {
  readonly subscribeToDetectedTokens: SubscribeToDetectedTokens;
  readonly subscribeToTradeObserved: SubscribeToTradeObserved;
  readonly subscribeToTrackingClosed: SubscribeToTrackingClosed;
  readonly publishAnalysisCompleted: PublishAnalysisCompleted;
  readonly rugcheckClient: RugCheckClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly cooldownMs?: number;
};

type EnrichmentState = {
  readonly detected: DetectedToken;
  status: 'idle' | 'in-flight' | 'succeeded';
  lastAttemptMonotonicMs: number | null;
  lastError: RugCheckFetchError | null;
  published: boolean;
};

export const wireEnrichment = (deps: WireEnrichmentDeps): void => {
  if (deps.signal.aborted) return;

  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const states = new Map<string, EnrichmentState>();

  const tryEnrich = async (mint: string): Promise<void> => {
    const state = states.get(mint);
    if (state === undefined) return;
    if (state.status !== 'idle') return;

    const now = deps.clock.monotonicMs();
    if (state.lastAttemptMonotonicMs !== null && now - state.lastAttemptMonotonicMs < cooldownMs) {
      return;
    }

    state.status = 'in-flight';
    state.lastAttemptMonotonicMs = now;

    const result = await deps.rugcheckClient.fetchReport(state.detected.mint, deps.signal);
    if (deps.signal.aborted) return;

    const current = states.get(mint);
    if (current === undefined) return;

    if (result.kind === 'ok') {
      current.status = 'succeeded';
      current.published = true;
      deps.publishAnalysisCompleted({
        detected: current.detected,
        analyzedAt: deps.clock.now(),
        rugcheck: result,
      });
      deps.logger.info(
        {
          mint: current.detected.mint,
          internalId: current.detected.internalId,
          scoreNormalised: result.value.scoreNormalised,
          rugged: result.value.rugged,
          totalHolders: result.value.totalHolders,
        },
        'rugcheck analysis succeeded',
      );
      return;
    }

    current.status = 'idle';
    current.lastError = result.error;
    deps.logger.debug(
      {
        mint: current.detected.mint,
        internalId: current.detected.internalId,
        reason: result.error.kind,
        httpStatus: result.error.kind === 'http_error' ? result.error.status : undefined,
      },
      'rugcheck attempt failed; will retry on next trade',
    );
  };

  const onDetected = (token: DetectedToken): void => {
    if (states.has(token.mint)) return;
    states.set(token.mint, {
      detected: token,
      status: 'idle',
      lastAttemptMonotonicMs: null,
      lastError: null,
      published: false,
    });
  };

  const onTrade = (trade: TokenTradeObserved): void => {
    tryEnrich(trade.mint).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      deps.logger.error({ err: message, mint: trade.mint }, 'enrichment threw unexpectedly');
    });
  };

  const onTrackingClosed = (closed: TokenTrackingClosed): void => {
    const state = states.get(closed.mint);
    if (state === undefined) return;

    if (!state.published) {
      const finalError: RugCheckFetchError = state.lastError ?? {
        kind: 'network_error',
        message: 'no observable activity within tracking window',
      };
      deps.publishAnalysisCompleted({
        detected: state.detected,
        analyzedAt: deps.clock.now(),
        rugcheck: err(finalError),
      });
      deps.logger.warn(
        {
          mint: closed.mint,
          internalId: state.detected.internalId,
          reason: finalError.kind,
          httpStatus: finalError.kind === 'http_error' ? finalError.status : undefined,
        },
        'rugcheck never succeeded; publishing final err at tracking close',
      );
    }
    states.delete(closed.mint);
  };

  const unsubDetected = deps.subscribeToDetectedTokens(onDetected);
  const unsubTrade = deps.subscribeToTradeObserved(onTrade);
  const unsubClosed = deps.subscribeToTrackingClosed(onTrackingClosed);

  deps.signal.addEventListener(
    'abort',
    () => {
      unsubDetected();
      unsubTrade();
      unsubClosed();
      states.clear();
    },
    { once: true },
  );
};
