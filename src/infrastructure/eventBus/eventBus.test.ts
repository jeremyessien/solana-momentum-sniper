import { describe, expect, test, vi } from 'vitest';
import { createEventBus } from './eventBus.js';

type TestEvents = {
  greeting: { message: string };
  count: number;
};

const flushMicrotasks = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });

describe('createEventBus', () => {
  test('subscriber receives the published payload', async () => {
    const bus = createEventBus<TestEvents>();
    const handler = vi.fn();

    bus.subscribe('greeting', handler);
    bus.publish('greeting', { message: 'hello' });

    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ message: 'hello' });
  });

  test('multiple subscribers all receive the event', async () => {
    const bus = createEventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();

    bus.subscribe('count', a);
    bus.subscribe('count', b);
    bus.publish('count', 42);

    await flushMicrotasks();
    expect(a).toHaveBeenCalledWith(42);
    expect(b).toHaveBeenCalledWith(42);
  });

  test('unsubscribed handler stops receiving events', async () => {
    const bus = createEventBus<TestEvents>();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('count', handler);

    bus.publish('count', 1);
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    bus.publish('count', 2);
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('publishing with no subscribers is a silent no-op', () => {
    const bus = createEventBus<TestEvents>();
    expect(() => bus.publish('count', 1)).not.toThrow();
  });

  test('async handler receives events independently of others', async () => {
    const bus = createEventBus<TestEvents>();
    const received: number[] = [];

    bus.subscribe('count', async (n) => {
      await Promise.resolve();
      received.push(n);
    });
    bus.publish('count', 1);
    bus.publish('count', 2);

    await flushMicrotasks();
    expect(received).toEqual([1, 2]);
  });

  test('iterate yields events published while iterating', async () => {
    const bus = createEventBus<TestEvents>();
    const ctrl = new AbortController();
    const received: number[] = [];

    const iterPromise = (async () => {
      for await (const n of bus.iterate('count', { signal: ctrl.signal })) {
        received.push(n);
        if (received.length === 3) break;
      }
    })();

    bus.publish('count', 1);
    bus.publish('count', 2);
    bus.publish('count', 3);

    await iterPromise;
    expect(received).toEqual([1, 2, 3]);
  });

  test('iterate queues events arriving after iterate() but before iteration starts', async () => {
    const bus = createEventBus<TestEvents>();
    const ctrl = new AbortController();
    const iterable = bus.iterate('count', { signal: ctrl.signal });

    bus.publish('count', 10);
    bus.publish('count', 20);
    await flushMicrotasks();

    const received: number[] = [];
    for await (const n of iterable) {
      received.push(n);
      if (received.length === 2) break;
    }
    expect(received).toEqual([10, 20]);
  });

  test('iterate loop completes when signal aborts', async () => {
    const bus = createEventBus<TestEvents>();
    const ctrl = new AbortController();
    const received: number[] = [];

    const iterPromise = (async () => {
      for await (const n of bus.iterate('count', { signal: ctrl.signal })) {
        received.push(n);
      }
    })();

    bus.publish('count', 1);
    await flushMicrotasks();
    ctrl.abort();

    await iterPromise;
    expect(received).toEqual([1]);
  });

  test('iterate completes immediately when signal is already aborted', async () => {
    const bus = createEventBus<TestEvents>();
    const ctrl = new AbortController();
    ctrl.abort();

    const received: number[] = [];
    for await (const n of bus.iterate('count', { signal: ctrl.signal })) {
      received.push(n);
    }
    expect(received).toEqual([]);
  });

  test('iterate supports concurrent iterators that each receive every event', async () => {
    const bus = createEventBus<TestEvents>();
    const ctrl = new AbortController();
    const a: number[] = [];
    const b: number[] = [];

    const p1 = (async () => {
      for await (const n of bus.iterate('count', { signal: ctrl.signal })) {
        a.push(n);
        if (a.length === 2) break;
      }
    })();
    const p2 = (async () => {
      for await (const n of bus.iterate('count', { signal: ctrl.signal })) {
        b.push(n);
        if (b.length === 2) break;
      }
    })();

    bus.publish('count', 1);
    bus.publish('count', 2);

    await Promise.all([p1, p2]);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  test('iterate cleanup runs when the loop body throws', async () => {
    const bus = createEventBus<TestEvents>();
    const ctrl = new AbortController();
    const received: number[] = [];

    const iterPromise = (async () => {
      for await (const n of bus.iterate('count', { signal: ctrl.signal })) {
        received.push(n);
        throw new Error('consumer-side blow-up');
      }
    })();

    bus.publish('count', 99);
    await expect(iterPromise).rejects.toThrow('consumer-side blow-up');

    // After the throw, the subscription has been torn down. A subsequent
    // regular subscriber should still receive new publishes (i.e. the bus
    // itself is intact and the now-dead iterator no longer competes for them).
    const after = vi.fn();
    bus.subscribe('count', after);
    bus.publish('count', 100);
    await flushMicrotasks();
    expect(received).toEqual([99]);
    expect(after).toHaveBeenCalledWith(100);
  });

  test('onIteratorBacklog fires once when queue depth first reaches 100', async () => {
    const backlogs: Array<{ depth: number; event: string }> = [];
    const bus = createEventBus<TestEvents>({
      onIteratorBacklog: (depth, event) => backlogs.push({ depth, event }),
    });
    const ctrl = new AbortController();

    const iter = bus.iterate('count', { signal: ctrl.signal });

    for (let i = 0; i < 150; i++) bus.publish('count', i);
    await flushMicrotasks();

    let received = 0;
    for await (const _ of iter) {
      received++;
      if (received === 150) break;
    }

    expect(backlogs).toHaveLength(1);
    expect(backlogs[0]).toEqual({ depth: 100, event: 'count' });
  });

  test('onIteratorBacklog fires a second time when depth reaches 1000', async () => {
    const backlogs: Array<{ depth: number; event: string }> = [];
    const bus = createEventBus<TestEvents>({
      onIteratorBacklog: (depth, event) => backlogs.push({ depth, event }),
    });
    const ctrl = new AbortController();

    const iter = bus.iterate('count', { signal: ctrl.signal });

    for (let i = 0; i < 1_200; i++) bus.publish('count', i);
    await flushMicrotasks();

    let received = 0;
    for await (const _ of iter) {
      received++;
      if (received === 1_200) break;
    }

    expect(backlogs.map((b) => b.depth)).toEqual([100, 1_000]);
  });

  test('onIteratorBacklog stays silent when depth never reaches the threshold', async () => {
    const backlogs: number[] = [];
    const bus = createEventBus<TestEvents>({
      onIteratorBacklog: (depth) => backlogs.push(depth),
    });
    const ctrl = new AbortController();

    const iter = bus.iterate('count', { signal: ctrl.signal });

    for (let i = 0; i < 99; i++) bus.publish('count', i);
    await flushMicrotasks();

    let received = 0;
    for await (const _ of iter) {
      received++;
      if (received === 99) break;
    }

    expect(backlogs).toEqual([]);
  });

  test('iterate works without an onIteratorBacklog callback', async () => {
    const bus = createEventBus<TestEvents>();
    const ctrl = new AbortController();

    const iter = bus.iterate('count', { signal: ctrl.signal });
    for (let i = 0; i < 150; i++) bus.publish('count', i);
    await flushMicrotasks();

    let received = 0;
    for await (const _ of iter) {
      received++;
      if (received === 150) break;
    }
    expect(received).toBe(150);
  });

  test('onIteratorBacklog throws are routed to errorSink', async () => {
    const errors: Array<{ name: string; message: string }> = [];
    const bus = createEventBus<TestEvents>({
      errorSink: (err, name) => {
        errors.push({
          name,
          message: err instanceof Error ? err.message : String(err),
        });
      },
      onIteratorBacklog: () => {
        throw new Error('backlog handler boom');
      },
    });
    const ctrl = new AbortController();

    const iter = bus.iterate('count', { signal: ctrl.signal });
    for (let i = 0; i < 100; i++) bus.publish('count', i);
    await flushMicrotasks();

    let received = 0;
    for await (const _ of iter) {
      received++;
      if (received === 100) break;
    }

    expect(errors).toEqual([{ name: 'count', message: 'backlog handler boom' }]);
  });

  test('errorSink is invoked for sync throws and async rejections; other handlers still run', async () => {
    const errors: Array<{ name: string; message: string }> = [];
    const bus = createEventBus<TestEvents>({
      errorSink: (err, name) => {
        errors.push({
          name,
          message: err instanceof Error ? err.message : String(err),
        });
      },
    });
    const ok = vi.fn();

    bus.subscribe('count', () => {
      throw new Error('sync boom');
    });
    bus.subscribe('count', async () => {
      throw new Error('async boom');
    });
    bus.subscribe('count', ok);

    bus.publish('count', 7);
    await flushMicrotasks();

    expect(ok).toHaveBeenCalledWith(7);
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.message).sort()).toEqual(['async boom', 'sync boom']);
    expect(errors.every((e) => e.name === 'count')).toBe(true);
  });
});
