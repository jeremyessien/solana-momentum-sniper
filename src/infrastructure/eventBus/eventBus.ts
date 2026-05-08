type EventHandler<P> = (payload: P) => void | Promise<void>;

export type EventErrorSink = (error: unknown, eventName: string) => void;

export type EventBus<TEventMap extends Record<string, unknown>> = {
  readonly publish: <K extends keyof TEventMap & string>(name: K, payload: TEventMap[K]) => void;
  readonly subscribe: <K extends keyof TEventMap & string>(
    name: K,
    handler: EventHandler<TEventMap[K]>,
  ) => () => void;
};

export type CreateEventBusOptions = {
  readonly errorSink?: EventErrorSink;
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

  return { publish, subscribe };
};
