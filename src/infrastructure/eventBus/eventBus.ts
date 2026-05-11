type EventHandler<P> = (payload: P) => void | Promise<void>;

export type EventErrorSink = (error: unknown, eventName: string) => void;

export type IteratorBacklogSink = (depth: number, eventName: string) => void;

const BACKLOG_WARN_DEPTH = 100;
const BACKLOG_ERROR_DEPTH = 1_000;

export type IterateOptions = {
  readonly signal: AbortSignal;
};

export type EventBus<TEventMap extends Record<string, unknown>> = {
  readonly publish: <K extends keyof TEventMap & string>(name: K, payload: TEventMap[K]) => void;
  readonly subscribe: <K extends keyof TEventMap & string>(
    name: K,
    handler: EventHandler<TEventMap[K]>,
  ) => () => void;
  readonly iterate: <K extends keyof TEventMap & string>(
    name: K,
    options: IterateOptions,
  ) => AsyncIterable<TEventMap[K]>;
};

export type CreateEventBusOptions = {
  readonly errorSink?: EventErrorSink;
  readonly onIteratorBacklog?: IteratorBacklogSink;
};

const defaultErrorSink: EventErrorSink = (error, eventName) => {
  // Until a logger module exists, surface handler errors loudly on the next
  // tick. Main wires a logger-backed sink in production.
  queueMicrotask(() => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`event handler for '${eventName}' failed: ${message}`);
  });
};

export const createEventBus = <TEventMap extends Record<string, unknown>>(
  options: CreateEventBusOptions = {},
): EventBus<TEventMap> => {
  const subscribers = new Map<string, Set<EventHandler<unknown>>>();
  const errorSink = options.errorSink ?? defaultErrorSink;
  const onIteratorBacklog = options.onIteratorBacklog;

  const publish = <K extends keyof TEventMap & string>(name: K, payload: TEventMap[K]): void => {
    const handlers = subscribers.get(name);
    if (!handlers || handlers.size === 0) {
      return;
    }
    // Snapshot so subscribe/unsubscribe during dispatch only affects future
    // publishes, not the current one.
    const snapshot = [...handlers];
    for (const handler of snapshot) {
      queueMicrotask(() => {
        try {
          const typed = handler as EventHandler<TEventMap[K]>;
          const result = typed(payload);
          if (result instanceof Promise) {
            result.catch((err: unknown) => {
              errorSink(err, name);
            });
          }
        } catch (err) {
          errorSink(err, name);
        }
      });
    }
  };

  const subscribe = <K extends keyof TEventMap & string>(
    name: K,
    handler: EventHandler<TEventMap[K]>,
  ): (() => void) => {
    let handlers = subscribers.get(name);
    if (!handlers) {
      handlers = new Set();
      subscribers.set(name, handlers);
    }
    const generic = handler as EventHandler<unknown>;
    handlers.add(generic);
    return () => {
      handlers.delete(generic);
    };
  };

  const iterate = <K extends keyof TEventMap & string>(
    name: K,
    options: IterateOptions,
  ): AsyncIterable<TEventMap[K]> => {
    const { signal } = options;
    const queue: TEventMap[K][] = [];
    let resolveNext: (() => void) | null = null;
    let done = signal.aborted;
    let firedWarnDepth = false;
    let firedErrorDepth = false;

    const wakeUp = (): void => {
      if (resolveNext === null) return;
      const r = resolveNext;
      resolveNext = null;
      r();
    };

    const reportBacklog = (depth: number): void => {
      if (onIteratorBacklog === undefined) return;
      try {
        onIteratorBacklog(depth, name);
      } catch (err) {
        errorSink(err, name);
      }
    };

    const handler: EventHandler<TEventMap[K]> = (payload) => {
      if (done) return;
      queue.push(payload);
      if (!firedWarnDepth && queue.length >= BACKLOG_WARN_DEPTH) {
        firedWarnDepth = true;
        reportBacklog(queue.length);
      }
      if (!firedErrorDepth && queue.length >= BACKLOG_ERROR_DEPTH) {
        firedErrorDepth = true;
        reportBacklog(queue.length);
      }
      wakeUp();
    };

    const onAbort = (): void => {
      done = true;
      wakeUp();
    };

    const unsubscribe = subscribe(name, handler);
    if (!done) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    return (async function* (): AsyncGenerator<TEventMap[K], void, undefined> {
      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift() as TEventMap[K];
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
      } finally {
        done = true;
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
      }
    })();
  };

  return { publish, subscribe, iterate };
};
