import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import type { Clock } from '../infrastructure/clock/clock.js';
import { createEventBus } from '../infrastructure/eventBus/eventBus.js';
import { createLogger, type Logger } from '../infrastructure/logger/logger.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import type { EventMap } from '../shared/eventMap.js';
import type { ProgramLogEvent } from '../shared/programLogEvent.js';
import { wireDetection } from './wireDetection.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures',
);

type FixtureFile = {
  readonly transaction: {
    readonly signature: string;
    readonly slot: string;
    readonly logs: readonly string[];
  };
};

const loadFixtureEvent = (filename: string): ProgramLogEvent => {
  const fixture = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8'),
  ) as FixtureFile;
  return {
    signature: fixture.transaction.signature,
    slot: BigInt(fixture.transaction.slot),
    logs: fixture.transaction.logs,
    err: null,
  };
};

const FIXED_DATE = new Date('2026-05-11T00:00:00Z');

const makeClock = (now: Date = FIXED_DATE): Clock => ({
  now: () => now,
  monotonicMs: () => 0,
  sleep: () => Promise.resolve(),
});

const silentLogger = (): Logger =>
  createLogger({ level: 'error', isDevelopment: false }, { write: () => {} });

const capturingLogger = (): { logger: Logger; lines: string[] } => {
  const lines: string[] = [];
  const logger = createLogger(
    { level: 'info', isDevelopment: false },
    {
      write: (line) => {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
};

const drainMicrotasks = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

type LogLineShape = {
  readonly level: number;
  readonly msg: string;
  readonly launchpad: string;
  readonly mint: string;
  readonly creatorWallet: string;
  readonly initialLiquidityLamports: string;
  readonly internalId: string;
  readonly signature: string;
  readonly slot: string;
};

describe('wireDetection', () => {
  test('publishes a DetectedToken with injected internalId and detectedAt when the parser succeeds', () => {
    const fixture = loadFixtureEvent('pumpfun-create-v2-sample.json');
    const handlers: Array<(event: ProgramLogEvent) => void> = [];
    const published: DetectedToken[] = [];

    wireDetection({
      subscribeToRawLogs: (h) => {
        handlers.push(h);
        return () => {
          const i = handlers.indexOf(h);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
      publishToken: (t) => published.push(t),
      clock: makeClock(),
      logger: silentLogger(),
      idGenerator: () => 'id-1',
      signal: new AbortController().signal,
    });

    handlers[0]?.(fixture);

    expect(published).toHaveLength(1);
    const token = published[0];
    expect(token).toBeDefined();
    if (!token) return;
    expect(token.internalId).toBe('id-1');
    expect(token.detectedAt).toBe(FIXED_DATE);
    expect(token.launchpad).toBe('pumpfun');
    expect(typeof token.initialLiquidityLamports).toBe('bigint');
  });

  test('does not publish when the parser returns null', () => {
    const handlers: Array<(event: ProgramLogEvent) => void> = [];
    const published: DetectedToken[] = [];

    wireDetection({
      subscribeToRawLogs: (h) => {
        handlers.push(h);
        return () => {};
      },
      publishToken: (t) => published.push(t),
      clock: makeClock(),
      logger: silentLogger(),
      idGenerator: () => 'id-1',
      signal: new AbortController().signal,
    });

    handlers[0]?.({
      signature: 'sig',
      slot: 1n,
      logs: ['Program log: not a create event'],
      err: null,
    });

    expect(published).toHaveLength(0);
  });

  test('logs the detection at info with bigint fields serialized as strings', () => {
    const fixture = loadFixtureEvent('pumpfun-create-v2-sample.json');
    const handlers: Array<(event: ProgramLogEvent) => void> = [];
    const { logger, lines } = capturingLogger();

    wireDetection({
      subscribeToRawLogs: (h) => {
        handlers.push(h);
        return () => {};
      },
      publishToken: () => {},
      clock: makeClock(),
      logger,
      idGenerator: () => 'id-1',
      signal: new AbortController().signal,
    });

    handlers[0]?.(fixture);

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toBeDefined();
    if (!line) return;
    const entry = JSON.parse(line) as LogLineShape;
    expect(entry.level).toBe(30);
    expect(entry.msg).toBe('new token launch detected');
    expect(entry.launchpad).toBe('pumpfun');
    expect(entry.internalId).toBe('id-1');
    expect(typeof entry.initialLiquidityLamports).toBe('string');
    expect(typeof entry.slot).toBe('string');
  });

  test('returns early without subscribing when the signal is already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const subscribe = vi.fn<SubscribeFn>();

    wireDetection({
      subscribeToRawLogs: subscribe,
      publishToken: () => {},
      clock: makeClock(),
      logger: silentLogger(),
      idGenerator: () => 'id-1',
      signal: ctrl.signal,
    });

    expect(subscribe).not.toHaveBeenCalled();
  });

  test('unsubscribes exactly once when the signal aborts after subscription', () => {
    const ctrl = new AbortController();
    const unsubscribe = vi.fn();

    wireDetection({
      subscribeToRawLogs: () => unsubscribe,
      publishToken: () => {},
      clock: makeClock(),
      logger: silentLogger(),
      idGenerator: () => 'id-1',
      signal: ctrl.signal,
    });

    expect(unsubscribe).not.toHaveBeenCalled();
    ctrl.abort();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('integration: publishes newTokenLaunchDetected through a real event bus for a fixture event', async () => {
    const fixture = loadFixtureEvent('pumpfun-create-v2-sample.json');
    const bus = createEventBus<EventMap>();
    const detected: DetectedToken[] = [];

    bus.subscribe('newTokenLaunchDetected', (t) => {
      detected.push(t);
    });

    const ctrl = new AbortController();
    let counter = 0;
    wireDetection({
      subscribeToRawLogs: (h) => bus.subscribe('rawProgramLogReceived', h),
      publishToken: (t) => bus.publish('newTokenLaunchDetected', t),
      clock: makeClock(),
      logger: silentLogger(),
      idGenerator: () => `id-${++counter}`,
      signal: ctrl.signal,
    });

    bus.publish('rawProgramLogReceived', fixture);
    await drainMicrotasks();
    await drainMicrotasks();

    expect(detected).toHaveLength(1);
    const token = detected[0];
    expect(token).toBeDefined();
    if (!token) return;
    expect(token.internalId).toBe('id-1');
    expect(token.launchpad).toBe('pumpfun');
  });
});

type SubscribeFn = (handler: (event: ProgramLogEvent) => void) => () => void;
