import type { Commitment, ProgramLogEvent } from '../../shared/programLogEvent.js';
import type { Clock } from '../clock/clock.js';
import type { Logger } from '../logger/logger.js';

export type SubscriptionSource = {
  readonly streamLogs: (
    programId: string,
    commitment: Commitment,
    signal: AbortSignal,
  ) => AsyncIterable<ProgramLogEvent>;
};

export type HeliusAdapter = {
  readonly subscribeToProgramLogs: (
    programId: string,
    options: {
      readonly signal: AbortSignal;
      readonly commitment?: Commitment;
    },
  ) => AsyncIterable<ProgramLogEvent>;
};

export type HeliusAdapterConfig = {
  readonly source: SubscriptionSource;
  readonly clock: Clock;
  readonly logger: Logger;
};

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export const createHeliusAdapter = (config: HeliusAdapterConfig): HeliusAdapter => {
  const { source, clock, logger } = config;

  async function* subscribeToProgramLogs(
    programId: string,
    options: { readonly signal: AbortSignal; readonly commitment?: Commitment },
  ): AsyncGenerator<ProgramLogEvent, void, undefined> {
    const commitment = options.commitment ?? 'confirmed';
    let backoffMs = INITIAL_BACKOFF_MS;

    while (!options.signal.aborted) {
      try {
        const stream = source.streamLogs(programId, commitment, options.signal);
        for await (const event of stream) {
          yield event;
          backoffMs = INITIAL_BACKOFF_MS;
        }
      } catch (err) {
        if (options.signal.aborted) return;
        logger.warn({ err, programId, backoffMs }, 'helius subscription dropped; reconnecting');
        try {
          await clock.sleep(backoffMs, { signal: options.signal });
        } catch {
          return;
        }
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  return { subscribeToProgramLogs };
};
