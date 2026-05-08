import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSystemClock } from './clock.js';

describe('createSystemClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('now', () => {
    test('returns a Date close to actual wall time', () => {
      const clock = createSystemClock();
      const before = Date.now();
      const result = clock.now();
      const after = Date.now();

      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('monotonicMs', () => {
    test('returns a number that increases across calls', async () => {
      const clock = createSystemClock();
      const t1 = clock.monotonicMs();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
      const t2 = clock.monotonicMs();

      expect(typeof t1).toBe('number');
      expect(t2).toBeGreaterThan(t1);
    });
  });

  describe('sleep', () => {
    test('resolves only after the requested duration elapses', async () => {
      vi.useFakeTimers();
      const clock = createSystemClock();
      let resolved = false;
      const promise = clock.sleep(1000).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      await promise;
      expect(resolved).toBe(true);
    });

    test('rejects immediately if the signal is already aborted', async () => {
      const clock = createSystemClock();
      const controller = new AbortController();
      controller.abort();

      await expect(clock.sleep(1000, { signal: controller.signal })).rejects.toThrow();
    });

    test('rejects when the signal aborts mid-flight', async () => {
      vi.useFakeTimers();
      const clock = createSystemClock();
      const controller = new AbortController();
      const sleepPromise = clock.sleep(10_000, { signal: controller.signal });

      await vi.advanceTimersByTimeAsync(500);
      controller.abort();

      await expect(sleepPromise).rejects.toThrow();
    });
  });
});
