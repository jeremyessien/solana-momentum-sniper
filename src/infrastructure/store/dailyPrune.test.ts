import pino from 'pino';
import { describe, expect, test, vi } from 'vitest';
import type { Clock } from '../clock/clock.js';
import { computeMsUntilNextHourUtc, scheduleDailyPrune } from './dailyPrune.js';
import type { EventStore } from './eventStore.js';

const silentLogger = pino({ level: 'silent' });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const stubPrune = (): Pick<EventStore, 'pruneTradesOlderThan'> => ({
  pruneTradesOlderThan: vi.fn().mockReturnValue({ rowsDeleted: 0 }),
});

describe('computeMsUntilNextHourUtc', () => {
  test('returns time to next hour today when current time is before the hour', () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    expect(computeMsUntilNextHourUtc(now, 4)).toBe(60 * 60 * 1000);
  });

  test('returns time to tomorrow when current time is past the hour', () => {
    const now = new Date('2026-05-15T05:00:00.000Z');
    expect(computeMsUntilNextHourUtc(now, 4)).toBe(23 * 60 * 60 * 1000);
  });

  test('returns full 24h when current time equals the target hour exactly', () => {
    const now = new Date('2026-05-15T04:00:00.000Z');
    expect(computeMsUntilNextHourUtc(now, 4)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('scheduleDailyPrune', () => {
  test('does not start if signal already aborted', async () => {
    const eventStore = stubPrune();
    const sleep = vi.fn();
    const clock: Clock = {
      now: () => new Date('2026-05-15T03:00:00.000Z'),
      monotonicMs: () => 0,
      sleep,
    };
    const ctrl = new AbortController();
    ctrl.abort();

    scheduleDailyPrune({
      eventStore,
      retentionMs: 90 * 24 * 60 * 60 * 1000,
      clock,
      logger: silentLogger,
      signal: ctrl.signal,
    });

    await flush();
    expect(sleep).not.toHaveBeenCalled();
  });

  test('runs the prune after sleeping until the configured hour', async () => {
    const eventStore = stubPrune();
    let mockNow = new Date('2026-05-15T03:59:59.000Z');
    const ctrl = new AbortController();
    const sleep = vi
      .fn()
      .mockImplementationOnce(async () => {
        mockNow = new Date('2026-05-15T04:00:00.000Z');
      })
      .mockImplementationOnce(async () => {
        ctrl.abort();
        throw new Error('aborted');
      });
    const clock: Clock = { now: () => mockNow, monotonicMs: () => 0, sleep };

    scheduleDailyPrune({
      eventStore,
      retentionMs: 90 * 24 * 60 * 60 * 1000,
      clock,
      logger: silentLogger,
      signal: ctrl.signal,
      pruneHourUtc: 4,
    });

    await flush();
    expect(eventStore.pruneTradesOlderThan).toHaveBeenCalled();
  });

  test('uses the retention window to compute the cutoff', async () => {
    const eventStore = stubPrune();
    const retentionMs = 30 * 24 * 60 * 60 * 1000;
    const pruneTime = new Date('2026-05-15T04:00:00.000Z');
    let mockNow = new Date('2026-05-15T03:59:59.000Z');
    const ctrl = new AbortController();
    const sleep = vi
      .fn()
      .mockImplementationOnce(async () => {
        mockNow = pruneTime;
      })
      .mockImplementationOnce(async () => {
        ctrl.abort();
        throw new Error('aborted');
      });
    const clock: Clock = { now: () => mockNow, monotonicMs: () => 0, sleep };

    scheduleDailyPrune({
      eventStore,
      retentionMs,
      clock,
      logger: silentLogger,
      signal: ctrl.signal,
    });

    await flush();
    const expectedCutoff = BigInt(pruneTime.getTime() - retentionMs);
    expect(eventStore.pruneTradesOlderThan).toHaveBeenCalledWith(expectedCutoff);
  });

  test('exits the loop cleanly when signal aborts during the first sleep', async () => {
    const eventStore = stubPrune();
    const ctrl = new AbortController();
    const sleep = vi.fn().mockImplementation(async () => {
      ctrl.abort();
      throw new Error('aborted');
    });
    const clock: Clock = {
      now: () => new Date('2026-05-15T03:59:59.000Z'),
      monotonicMs: () => 0,
      sleep,
    };

    scheduleDailyPrune({
      eventStore,
      retentionMs: 90 * 24 * 60 * 60 * 1000,
      clock,
      logger: silentLogger,
      signal: ctrl.signal,
    });

    await flush();
    expect(eventStore.pruneTradesOlderThan).not.toHaveBeenCalled();
  });

  test('prune errors are caught and the loop terminates only on signal abort', async () => {
    const eventStore = {
      pruneTradesOlderThan: vi.fn().mockImplementation(() => {
        throw new Error('disk full');
      }),
    };
    const ctrl = new AbortController();
    const sleep = vi
      .fn()
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        ctrl.abort();
        throw new Error('aborted');
      });
    const clock: Clock = {
      now: () => new Date('2026-05-15T03:59:59.000Z'),
      monotonicMs: () => 0,
      sleep,
    };

    scheduleDailyPrune({
      eventStore,
      retentionMs: 90 * 24 * 60 * 60 * 1000,
      clock,
      logger: silentLogger,
      signal: ctrl.signal,
    });

    await flush();
    expect(eventStore.pruneTradesOlderThan).toHaveBeenCalledTimes(1);
  });
});
