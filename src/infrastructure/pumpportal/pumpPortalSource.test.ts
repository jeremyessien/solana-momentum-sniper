import { describe, expect, test } from 'vitest';
import type { DetectedToken } from '../../shared/detectedToken.js';
import type { Clock } from '../clock/clock.js';
import { createLogger, type Logger } from '../logger/logger.js';
import {
  type ConnectPumpPortal,
  createPumpPortalSource,
  type PumpPortalListener,
  type PumpPortalSocketEvent,
} from './pumpPortalSource.js';

const SUBSCRIBE_MESSAGE = JSON.stringify({ method: 'subscribeNewToken' });

const validFrame = JSON.stringify({
  txType: 'create',
  pool: 'pump',
  mint: '3dNTei6DqmoA97JkFqkTtbKDbLFwvpwUFJY8U9X4pump',
  traderPublicKey: '3VF7CW2JqRU79yq3WCHdGY67BA6x3UtBxzrTPE1cdTqk',
  vSolInBondingCurve: 30,
});

const bonkFrame = JSON.stringify({
  txType: 'create',
  pool: 'bonk',
  mint: 'x',
  traderPublicKey: 'y',
});

const createTestClock = (): { clock: Clock; sleepCalls: number[] } => {
  const sleepCalls: number[] = [];
  return {
    sleepCalls,
    clock: {
      now: () => new Date('2026-07-31T00:00:00Z'),
      monotonicMs: () => 0,
      sleep: (ms) => {
        sleepCalls.push(ms);
        return new Promise<void>((resolve) => setImmediate(resolve));
      },
    },
  };
};

const silentLogger = (): Logger =>
  createLogger({ level: 'error', isDevelopment: false }, { write: () => {} });

type FakeSocket = {
  emit: (event: PumpPortalSocketEvent) => void;
  sent: string[];
  closeCount: () => number;
  listenerCount: () => number;
};

const setup = (): {
  start: (signal: AbortSignal) => Promise<void>;
  sockets: FakeSocket[];
  published: DetectedToken[];
  sleepCalls: number[];
} => {
  const sockets: FakeSocket[] = [];
  const published: DetectedToken[] = [];
  const { clock, sleepCalls } = createTestClock();

  const connect: ConnectPumpPortal = () => {
    const listeners = new Set<PumpPortalListener>();
    const sent: string[] = [];
    let closes = 0;
    sockets.push({
      emit: (event) => {
        for (const listener of [...listeners]) listener(event);
      },
      sent,
      closeCount: () => closes,
      listenerCount: () => listeners.size,
    });
    return {
      send: (data) => {
        sent.push(data);
      },
      close: () => {
        closes++;
      },
      on: (listener) => {
        listeners.add(listener);
      },
      off: (listener) => {
        listeners.delete(listener);
      },
    };
  };

  const source = createPumpPortalSource({
    clock,
    logger: silentLogger(),
    idGenerator: () => 'gen-id',
    publishToken: (token) => published.push(token),
    connect,
  });

  return { start: source.start, sockets, published, sleepCalls };
};

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('createPumpPortalSource', () => {
  test('subscribes on open and publishes a mapped token for a valid create', async () => {
    const { start, sockets, published } = setup();
    const ctrl = new AbortController();
    const startPromise = start(ctrl.signal);

    expect(sockets).toHaveLength(1);
    sockets[0]?.emit({ type: 'open' });
    expect(sockets[0]?.sent).toEqual([SUBSCRIBE_MESSAGE]);

    sockets[0]?.emit({ type: 'message', data: validFrame });
    expect(published).toHaveLength(1);
    expect(published[0]?.mint).toBe('3dNTei6DqmoA97JkFqkTtbKDbLFwvpwUFJY8U9X4pump');
    expect(published[0]?.internalId).toBe('gen-id');
    expect(published[0]?.initialLiquidityLamports).toBe(30_000_000_000n);

    ctrl.abort();
    await startPromise;
  });

  test('does not publish for a non-Pump.fun frame', async () => {
    const { start, sockets, published } = setup();
    const ctrl = new AbortController();
    const startPromise = start(ctrl.signal);

    sockets[0]?.emit({ type: 'open' });
    sockets[0]?.emit({ type: 'message', data: bonkFrame });
    expect(published).toHaveLength(0);

    ctrl.abort();
    await startPromise;
  });

  test('reconnects after a close, with backoff reset by a prior message', async () => {
    const { start, sockets, sleepCalls } = setup();
    const ctrl = new AbortController();
    const startPromise = start(ctrl.signal);

    sockets[0]?.emit({ type: 'open' });
    sockets[0]?.emit({ type: 'message', data: validFrame });
    sockets[0]?.emit({ type: 'close' });
    await flush();

    expect(sockets).toHaveLength(2);
    expect(sleepCalls).toEqual([1_000]);

    ctrl.abort();
    await startPromise;
  });

  test('doubles backoff and caps at 60s across repeated closes with no messages', async () => {
    const { start, sockets, sleepCalls } = setup();
    const ctrl = new AbortController();
    const startPromise = start(ctrl.signal);

    for (let i = 0; i < 7; i += 1) {
      sockets[i]?.emit({ type: 'close' });
      await flush();
    }

    expect(sleepCalls).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);

    ctrl.abort();
    await startPromise;
  });

  test('reconnects after an error event', async () => {
    const { start, sockets, sleepCalls } = setup();
    const ctrl = new AbortController();
    const startPromise = start(ctrl.signal);

    sockets[0]?.emit({ type: 'error', error: new Error('boom') });
    await flush();

    expect(sockets).toHaveLength(2);
    expect(sleepCalls).toEqual([1_000]);

    ctrl.abort();
    await startPromise;
  });

  test('closes the socket and removes listeners on abort', async () => {
    const { start, sockets } = setup();
    const ctrl = new AbortController();
    const startPromise = start(ctrl.signal);

    sockets[0]?.emit({ type: 'open' });
    ctrl.abort();
    await startPromise;

    expect(sockets[0]?.closeCount()).toBe(1);
    expect(sockets[0]?.listenerCount()).toBe(0);
  });
});
