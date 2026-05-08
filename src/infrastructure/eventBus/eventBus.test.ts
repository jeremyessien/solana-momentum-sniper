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
