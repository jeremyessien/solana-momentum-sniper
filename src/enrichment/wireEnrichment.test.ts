import { describe, expect, test, vi } from 'vitest';
import type { Clock } from '../infrastructure/clock/clock.js';
import { createEventBus } from '../infrastructure/eventBus/eventBus.js';
import { createLogger, type Logger } from '../infrastructure/logger/logger.js';
import type { RugCheckClient } from '../infrastructure/rugcheck/rugCheckClient.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import type { EventMap } from '../shared/eventMap.js';
import { err, ok, type Result } from '../shared/result.js';
import type { RugCheckFetchError, RugCheckSnapshot } from '../shared/rugCheckSnapshot.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';
import { wireEnrichment } from './wireEnrichment.js';

const FIXED_DATE = new Date('2026-05-11T12:00:00Z');

const makeClock = (): Clock => ({
  now: () => FIXED_DATE,
  monotonicMs: () => 0,
  sleep: () => Promise.resolve(),
});

const silentLogger = (): Logger =>
  createLogger({ level: 'error', isDevelopment: false }, { write: () => {} });

const sampleToken = (overrides: Partial<DetectedToken> = {}): DetectedToken => ({
  internalId: 'test-internal-1',
  mint: 'TestMint1234',
  launchpad: 'pumpfun',
  creatorWallet: 'CreatorWallet',
  initialLiquidityLamports: 1_000_000_000n,
  detectedAt: new Date('2026-05-11T11:59:00Z'),
  ...overrides,
});

const sampleSnapshot = (): RugCheckSnapshot => ({
  snapshotAt: FIXED_DATE,
  mint: 'TestMint1234',
  score: 1,
  scoreNormalised: 1,
  risks: [],
  rugged: false,
  creatorBalance: 1_000_000_000n,
  mintAuthority: null,
  freezeAuthority: null,
  topHolders: [],
  totalHolders: 250,
  totalMarketLiquidityUsd: 50_000,
  tokenName: 'Test Token',
  tokenSymbol: 'TEST',
  rawJson: '{}',
});

const stubClient = (result: Result<RugCheckSnapshot, RugCheckFetchError>): RugCheckClient => ({
  fetchReport: vi.fn().mockResolvedValue(result),
});

const drainMicrotasks = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe('wireEnrichment', () => {
  test('publishes a successful analysis when rugcheck returns ok', async () => {
    const handlers: Array<(t: DetectedToken) => void | Promise<void>> = [];
    const published: TokenWithFullContext[] = [];
    const snap = sampleSnapshot();

    wireEnrichment({
      subscribeToDetectedTokens: (h) => {
        handlers.push(h);
        return () => {};
      },
      publishAnalysisCompleted: (a) => {
        published.push(a);
      },
      rugcheckClient: stubClient(ok(snap)),
      clock: makeClock(),
      logger: silentLogger(),
      signal: new AbortController().signal,
    });

    await handlers[0]?.(sampleToken());

    expect(published).toHaveLength(1);
    const analysis = published[0];
    expect(analysis).toBeDefined();
    if (!analysis) return;
    expect(analysis.detected.mint).toBe('TestMint1234');
    expect(analysis.analyzedAt).toBe(FIXED_DATE);
    expect(analysis.rugcheck.kind).toBe('ok');
    if (analysis.rugcheck.kind !== 'ok') return;
    expect(analysis.rugcheck.value.scoreNormalised).toBe(1);
  });

  test('publishes a failed analysis when rugcheck returns timeout', async () => {
    const handlers: Array<(t: DetectedToken) => void | Promise<void>> = [];
    const published: TokenWithFullContext[] = [];

    wireEnrichment({
      subscribeToDetectedTokens: (h) => {
        handlers.push(h);
        return () => {};
      },
      publishAnalysisCompleted: (a) => {
        published.push(a);
      },
      rugcheckClient: stubClient(err({ kind: 'timeout' })),
      clock: makeClock(),
      logger: silentLogger(),
      signal: new AbortController().signal,
    });

    await handlers[0]?.(sampleToken());

    expect(published).toHaveLength(1);
    const analysis = published[0];
    expect(analysis).toBeDefined();
    if (!analysis) return;
    expect(analysis.rugcheck.kind).toBe('err');
    if (analysis.rugcheck.kind !== 'err') return;
    expect(analysis.rugcheck.error.kind).toBe('timeout');
  });

  test('publishes a failed analysis when rugcheck returns http_error', async () => {
    const handlers: Array<(t: DetectedToken) => void | Promise<void>> = [];
    const published: TokenWithFullContext[] = [];

    wireEnrichment({
      subscribeToDetectedTokens: (h) => {
        handlers.push(h);
        return () => {};
      },
      publishAnalysisCompleted: (a) => {
        published.push(a);
      },
      rugcheckClient: stubClient(err({ kind: 'http_error', status: 503 })),
      clock: makeClock(),
      logger: silentLogger(),
      signal: new AbortController().signal,
    });

    await handlers[0]?.(sampleToken());

    expect(published).toHaveLength(1);
    const analysis = published[0];
    expect(analysis).toBeDefined();
    if (!analysis) return;
    if (analysis.rugcheck.kind !== 'err') return;
    expect(analysis.rugcheck.error.kind).toBe('http_error');
    if (analysis.rugcheck.error.kind !== 'http_error') return;
    expect(analysis.rugcheck.error.status).toBe(503);
  });

  test('does not subscribe when the signal is already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const subscribe = vi.fn();

    wireEnrichment({
      subscribeToDetectedTokens: subscribe as never,
      publishAnalysisCompleted: () => {},
      rugcheckClient: stubClient(ok(sampleSnapshot())),
      clock: makeClock(),
      logger: silentLogger(),
      signal: ctrl.signal,
    });

    expect(subscribe).not.toHaveBeenCalled();
  });

  test('unsubscribes when the signal aborts after wiring', () => {
    const ctrl = new AbortController();
    const unsubscribe = vi.fn();

    wireEnrichment({
      subscribeToDetectedTokens: () => unsubscribe,
      publishAnalysisCompleted: () => {},
      rugcheckClient: stubClient(ok(sampleSnapshot())),
      clock: makeClock(),
      logger: silentLogger(),
      signal: ctrl.signal,
    });

    expect(unsubscribe).not.toHaveBeenCalled();
    ctrl.abort();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('does not publish if the signal aborts between fetch and publish', async () => {
    const handlers: Array<(t: DetectedToken) => void | Promise<void>> = [];
    const published: TokenWithFullContext[] = [];
    const ctrl = new AbortController();

    const slowClient: RugCheckClient = {
      fetchReport: async () => {
        ctrl.abort();
        return ok(sampleSnapshot());
      },
    };

    wireEnrichment({
      subscribeToDetectedTokens: (h) => {
        handlers.push(h);
        return () => {};
      },
      publishAnalysisCompleted: (a) => {
        published.push(a);
      },
      rugcheckClient: slowClient,
      clock: makeClock(),
      logger: silentLogger(),
      signal: ctrl.signal,
    });

    await handlers[0]?.(sampleToken());

    expect(published).toHaveLength(0);
  });

  test('logs at info level on success and warn level on failure', async () => {
    const handlers: Array<(t: DetectedToken) => void | Promise<void>> = [];
    const infoFn = vi.fn();
    const warnFn = vi.fn();
    const logger = {
      info: infoFn,
      warn: warnFn,
      debug: vi.fn(),
      error: vi.fn(),
      level: 'info',
    } as unknown as Logger;

    wireEnrichment({
      subscribeToDetectedTokens: (h) => {
        handlers.push(h);
        return () => {};
      },
      publishAnalysisCompleted: () => {},
      rugcheckClient: stubClient(ok(sampleSnapshot())),
      clock: makeClock(),
      logger,
      signal: new AbortController().signal,
    });
    await handlers[0]?.(sampleToken());

    expect(infoFn).toHaveBeenCalledTimes(1);
    expect(warnFn).not.toHaveBeenCalled();

    const handlers2: Array<(t: DetectedToken) => void | Promise<void>> = [];
    wireEnrichment({
      subscribeToDetectedTokens: (h) => {
        handlers2.push(h);
        return () => {};
      },
      publishAnalysisCompleted: () => {},
      rugcheckClient: stubClient(err({ kind: 'network_error', message: 'down' })),
      clock: makeClock(),
      logger,
      signal: new AbortController().signal,
    });
    await handlers2[0]?.(sampleToken());

    expect(warnFn).toHaveBeenCalledTimes(1);
  });

  test('integration: publishes tokenAnalysisCompleted on a real event bus', async () => {
    const bus = createEventBus<EventMap>();
    const received: TokenWithFullContext[] = [];

    bus.subscribe('tokenAnalysisCompleted', (a) => {
      received.push(a);
    });

    const ctrl = new AbortController();
    wireEnrichment({
      subscribeToDetectedTokens: (h) => bus.subscribe('newTokenLaunchDetected', h),
      publishAnalysisCompleted: (a) => bus.publish('tokenAnalysisCompleted', a),
      rugcheckClient: stubClient(ok(sampleSnapshot())),
      clock: makeClock(),
      logger: silentLogger(),
      signal: ctrl.signal,
    });

    bus.publish('newTokenLaunchDetected', sampleToken());
    await drainMicrotasks();
    await drainMicrotasks();
    await drainMicrotasks();

    expect(received).toHaveLength(1);
    const analysis = received[0];
    expect(analysis).toBeDefined();
    if (!analysis) return;
    expect(analysis.detected.mint).toBe('TestMint1234');
    expect(analysis.rugcheck.kind).toBe('ok');
  });
});
