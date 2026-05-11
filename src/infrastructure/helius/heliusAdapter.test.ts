import { describe, expect, test } from 'vitest';
import type { ProgramLogEvent } from '../../shared/programLogEvent.js';
import type { Clock } from '../clock/clock.js';
import { createLogger, type Logger } from '../logger/logger.js';
import { createHeliusAdapter, type SubscriptionSource } from './heliusAdapter.js';

const event = (signature: string, slot: bigint): ProgramLogEvent => ({
  signature,
  slot,
  logs: [],
  err: null,
});

const createTestClock = (): { clock: Clock; sleepCalls: number[] } => {
  const sleepCalls: number[] = [];
  return {
    sleepCalls,
    clock: {
      now: () => new Date(),
      monotonicMs: () => 0,
      sleep: (ms) => {
        sleepCalls.push(ms);
        return new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      },
    },
  };
};

const silentLogger = (): Logger =>
  createLogger({ level: 'error', isDevelopment: false }, { write: () => {} });

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

const PROGRAM = 'TestProgram111111111111111111111111111111111';

describe('createHeliusAdapter', () => {
  test('publishes all events from the source on the happy path', async () => {
    const events = [event('sig1', 100n), event('sig2', 101n), event('sig3', 102n)];
    const source: SubscriptionSource = {
      streamLogs: async function* (_programId, _commitment, signal) {
        for (const e of events) yield e;
        try {
          await waitForAbort(signal);
        } catch {
          /* expected */
        }
      },
    };
    const { clock } = createTestClock();
    const ctrl = new AbortController();
    const collected: ProgramLogEvent[] = [];
    const publishLog = (e: ProgramLogEvent): void => {
      collected.push(e);
      if (collected.length === events.length) ctrl.abort();
    };

    const adapter = createHeliusAdapter({
      source,
      clock,
      logger: silentLogger(),
      publishLog,
    });
    await adapter.start(PROGRAM, { signal: ctrl.signal });

    expect(collected).toEqual(events);
  });

  test('reconnects with a 1s backoff after the source drops', async () => {
    let attempt = 0;
    const source: SubscriptionSource = {
      streamLogs: async function* (_programId, _commitment, signal) {
        attempt++;
        if (attempt === 1) {
          yield event('sig1', 100n);
          throw new Error('connection dropped');
        }
        yield event('sig2', 101n);
        try {
          await waitForAbort(signal);
        } catch {
          /* expected */
        }
      },
    };
    const { clock, sleepCalls } = createTestClock();
    const ctrl = new AbortController();
    const collected: ProgramLogEvent[] = [];
    const publishLog = (e: ProgramLogEvent): void => {
      collected.push(e);
      if (collected.length === 2) ctrl.abort();
    };

    const adapter = createHeliusAdapter({
      source,
      clock,
      logger: silentLogger(),
      publishLog,
    });
    await adapter.start(PROGRAM, { signal: ctrl.signal });

    expect(collected).toEqual([event('sig1', 100n), event('sig2', 101n)]);
    expect(sleepCalls).toEqual([1_000]);
  });

  test('backoff doubles and caps at 60s on repeated drops', async () => {
    let attempt = 0;
    const source: SubscriptionSource = {
      streamLogs: async function* (_programId, _commitment, signal) {
        attempt++;
        if (attempt < 8) {
          throw new Error('drop');
        }
        yield event('eventually', 200n);
        try {
          await waitForAbort(signal);
        } catch {
          /* expected */
        }
      },
    };
    const { clock, sleepCalls } = createTestClock();
    const ctrl = new AbortController();
    const publishLog = (): void => ctrl.abort();

    const adapter = createHeliusAdapter({
      source,
      clock,
      logger: silentLogger(),
      publishLog,
    });
    await adapter.start(PROGRAM, { signal: ctrl.signal });

    expect(sleepCalls).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
  });

  test('exits cleanly when signal aborts mid-stream', async () => {
    const source: SubscriptionSource = {
      streamLogs: async function* (_programId, _commitment, signal) {
        yield event('first', 1n);
        await waitForAbort(signal);
      },
    };
    const { clock } = createTestClock();
    const ctrl = new AbortController();
    const collected: ProgramLogEvent[] = [];
    const publishLog = (e: ProgramLogEvent): void => {
      collected.push(e);
      if (collected.length === 1) ctrl.abort();
    };

    const adapter = createHeliusAdapter({
      source,
      clock,
      logger: silentLogger(),
      publishLog,
    });
    await adapter.start(PROGRAM, { signal: ctrl.signal });

    expect(collected).toEqual([event('first', 1n)]);
  });
});
