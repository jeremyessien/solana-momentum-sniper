import { parsePumpPortalNewToken } from '../../detection/pumpPortalNewTokenParser.js';
import type { DetectedToken } from '../../shared/detectedToken.js';
import type { Clock } from '../clock/clock.js';
import type { Logger } from '../logger/logger.js';

const DEFAULT_URL = 'wss://pumpportal.fun/api/data';
const SUBSCRIBE_MESSAGE = JSON.stringify({ method: 'subscribeNewToken' });
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export type PumpPortalSocketEvent =
  | { readonly type: 'open' }
  | { readonly type: 'message'; readonly data: string }
  | { readonly type: 'close' }
  | { readonly type: 'error'; readonly error: unknown };

export type PumpPortalListener = (event: PumpPortalSocketEvent) => void;

export type PumpPortalSocket = {
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly on: (listener: PumpPortalListener) => void;
  readonly off: (listener: PumpPortalListener) => void;
};

export type ConnectPumpPortal = (url: string) => PumpPortalSocket;

export type PumpPortalSourceConfig = {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly idGenerator: () => string;
  readonly publishToken: (token: DetectedToken) => void;
  readonly url?: string;
  readonly connect?: ConnectPumpPortal;
};

export type PumpPortalSource = {
  readonly start: (signal: AbortSignal) => Promise<void>;
};

const defaultConnect: ConnectPumpPortal = (url) => {
  const ws = new WebSocket(url);
  const listeners = new Set<PumpPortalListener>();
  const emit = (event: PumpPortalSocketEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  ws.addEventListener('open', () => emit({ type: 'open' }));
  ws.addEventListener('message', (event) => {
    const data = typeof event.data === 'string' ? event.data : String(event.data);
    emit({ type: 'message', data });
  });
  ws.addEventListener('close', () => emit({ type: 'close' }));
  ws.addEventListener('error', () => emit({ type: 'error', error: new Error('websocket error') }));
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on: (listener) => listeners.add(listener),
    off: (listener) => listeners.delete(listener),
  };
};

export const createPumpPortalSource = (config: PumpPortalSourceConfig): PumpPortalSource => {
  const { clock, logger, idGenerator, publishToken } = config;
  const url = config.url ?? DEFAULT_URL;
  const connect = config.connect ?? defaultConnect;

  const runConnection = (signal: AbortSignal, onMessage: () => void): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      let cleanup = (): void => {};
      const socket = connect(url);

      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.close();
        complete();
      };

      const onAbort = (): void => finish(resolve);

      const listener: PumpPortalListener = (event) => {
        switch (event.type) {
          case 'open':
            try {
              socket.send(SUBSCRIBE_MESSAGE);
            } catch (err) {
              finish(() => reject(err instanceof Error ? err : new Error('subscribe send failed')));
            }
            break;
          case 'message': {
            onMessage();
            const token = parsePumpPortalNewToken(event.data, {
              internalId: idGenerator(),
              detectedAt: clock.now(),
            });
            if (token !== null) {
              logger.info(
                {
                  mint: token.mint,
                  creatorWallet: token.creatorWallet,
                  initialLiquidityLamports: token.initialLiquidityLamports.toString(),
                  internalId: token.internalId,
                },
                'new token launch detected',
              );
              publishToken(token);
            }
            break;
          }
          case 'close':
            finish(() => reject(new Error('pumpportal socket closed')));
            break;
          case 'error':
            finish(() =>
              reject(
                event.error instanceof Error ? event.error : new Error('pumpportal socket error'),
              ),
            );
            break;
        }
      };

      cleanup = (): void => {
        socket.off(listener);
        signal.removeEventListener('abort', onAbort);
      };

      socket.on(listener);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) finish(resolve);
    });

  const start = async (signal: AbortSignal): Promise<void> => {
    let backoffMs = INITIAL_BACKOFF_MS;
    while (!signal.aborted) {
      try {
        await runConnection(signal, () => {
          backoffMs = INITIAL_BACKOFF_MS;
        });
      } catch (err) {
        if (signal.aborted) return;
        logger.warn({ err, backoffMs }, 'pumpportal source dropped; reconnecting');
        try {
          await clock.sleep(backoffMs, { signal });
        } catch {
          return;
        }
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  };

  return { start };
};
