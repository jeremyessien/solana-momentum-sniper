import { setTimeout as nodeSetTimeout } from 'node:timers/promises';

export type Clock = {
  /**
   * Wall-clock time. Use ONLY for human-readable serialisation —
   * log timestamps, audit entries, "opened at" fields. Do NOT use
   * for elapsed-time arithmetic: wall-clock can jump on NTP corrections
   * or DST transitions and produce nonsense durations.
   */
  readonly now: () => Date;

  /**
   * Monotonic time in milliseconds since an arbitrary origin.
   * Use for elapsed-time arithmetic. Guaranteed never to go backwards.
   * Only differences are meaningful; the absolute value is not.
   */
  readonly monotonicMs: () => number;

  /**
   * Async pause. Cancellable via AbortSignal — promise rejects with
   * the signal's reason if aborted before the timer fires.
   */
  readonly sleep: (ms: number, options?: { signal?: AbortSignal }) => Promise<void>;
};

export const createSystemClock = (): Clock => ({
  now: () => new Date(),
  monotonicMs: () => performance.now(),
  sleep: (ms, options) => nodeSetTimeout(ms, undefined, options),
});
