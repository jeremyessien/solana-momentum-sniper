import type { Clock } from '../clock/clock.js';
import type { Logger } from '../logger/logger.js';
import type { EventStore } from './eventStore.js';

const DEFAULT_PRUNE_HOUR_UTC = 4;

export type DailyPruneDeps = {
  readonly eventStore: Pick<EventStore, 'pruneTradesOlderThan'>;
  readonly retentionMs: number;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly pruneHourUtc?: number;
};

export const computeMsUntilNextHourUtc = (now: Date, hourUtc: number): number => {
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
};

export const scheduleDailyPrune = (deps: DailyPruneDeps): void => {
  if (deps.signal.aborted) return;

  const pruneHourUtc = deps.pruneHourUtc ?? DEFAULT_PRUNE_HOUR_UTC;

  const runOnce = (): void => {
    try {
      const now = deps.clock.now();
      const cutoffMs = BigInt(now.getTime() - deps.retentionMs);
      const result = deps.eventStore.pruneTradesOlderThan(cutoffMs);
      deps.logger.info(
        {
          rowsDeleted: result.rowsDeleted,
          cutoffMs: cutoffMs.toString(),
        },
        'retention prune complete',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error({ err: message }, 'retention prune failed');
    }
  };

  const loop = async (): Promise<void> => {
    while (!deps.signal.aborted) {
      const waitMs = computeMsUntilNextHourUtc(deps.clock.now(), pruneHourUtc);
      try {
        await deps.clock.sleep(waitMs, { signal: deps.signal });
      } catch {
        return;
      }
      if (deps.signal.aborted) return;
      runOnce();
    }
  };

  void loop();
};
