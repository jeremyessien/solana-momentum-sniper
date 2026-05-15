import { describe, expect, test, vi } from 'vitest';
import type { Clock } from '../infrastructure/clock/clock.js';
import { createEventBus } from '../infrastructure/eventBus/eventBus.js';
import { createLogger, type Logger } from '../infrastructure/logger/logger.js';
import type { RugCheckClient } from '../infrastructure/rugcheck/rugCheckClient.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import type { EventMap } from '../shared/eventMap.js';
import { err, ok, type Result } from '../shared/result.js';
import type { RugCheckFetchError, RugCheckSnapshot } from '../shared/rugCheckSnapshot.js';
import type { TokenTrackingClosed } from '../shared/tokenTrackingClosed.js';
import type { TokenTradeObserved } from '../shared/tokenTradeObserved.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';
import { wireEnrichment } from './wireEnrichment.js';

const FIXED_DATE = new Date('2026-05-15T12:00:00Z');

const makeClock = (monotonicMs = 0): Clock => ({
  now: () => FIXED_DATE,
  monotonicMs: () => monotonicMs,
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
  detectedAt: new Date('2026-05-15T11:59:00Z'),
  ...overrides,
});

const sampleTrade = (overrides: Partial<TokenTradeObserved> = {}): TokenTradeObserved => ({
  tokenInternalId: 'test-internal-1',
  mint: 'TestMint1234',
  trader: 'TraderWallet',
  isBuy: true,
  solAmount: 100_000_000n,
  tokenAmount: 1_000_000n,
  virtualSolReserves: 30_000_000_000n,
  virtualTokenReserves: 1_000_000_000_000n,
  slot: 250_000_000n,
  signature: 'sig-1',
  observedAt: FIXED_DATE,
  pumpFunTimestamp: 1_747_303_205n,
  ...overrides,
});

const sampleTrackingClosed = (
  overrides: Partial<TokenTrackingClosed> = {},
): TokenTrackingClosed => ({
  tokenInternalId: 'test-internal-1',
  mint: 'TestMint1234',
  closedAt: FIXED_DATE,
  reason: 'graduated',
  tradeCount: 10,
  buyCount: 6,
  sellCount: 4,
  uniqueTraders: 5,
  creatorTraded: false,
  firstTradeSlot: 250_000_000n,
  lastTradeSlot: 250_000_100n,
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
  tokenName: 'Test',
  tokenSymbol: 'TEST',
  rawJson: '{}',
});

const stubClient = (
  results: Array<Result<RugCheckSnapshot, RugCheckFetchError>>,
): RugCheckClient => {
  let i = 0;
  return {
    fetchReport: vi.fn().mockImplementation(async () => {
      const r = results[i] ?? results[results.length - 1];
      i++;
      if (r === undefined) throw new Error('test stubClient ran out of results');
      return r;
    }),
  };
};

type Captured = {
  fireDetected: (t: DetectedToken) => void;
  fireTrade: (t: TokenTradeObserved) => Promise<void>;
  fireClosed: (c: TokenTrackingClosed) => void;
  published: TokenWithFullContext[];
  fetchReportMock: ReturnType<typeof vi.fn>;
  unsubscribes: { detected: () => void; trade: () => void; closed: () => void };
};

const wireWithCaptured = (
  results: Array<Result<RugCheckSnapshot, RugCheckFetchError>>,
  clock: Clock = makeClock(),
  signal: AbortSignal = new AbortController().signal,
  cooldownMs?: number,
): Captured => {
  let detectedHandler: ((t: DetectedToken) => void | Promise<void>) | null = null;
  let tradeHandler: ((t: TokenTradeObserved) => void | Promise<void>) | null = null;
  let closedHandler: ((c: TokenTrackingClosed) => void | Promise<void>) | null = null;
  const unsubscribes = {
    detected: vi.fn(),
    trade: vi.fn(),
    closed: vi.fn(),
  };
  const published: TokenWithFullContext[] = [];
  const client = stubClient(results);

  const baseDeps = {
    subscribeToDetectedTokens: (h: (t: DetectedToken) => void | Promise<void>) => {
      detectedHandler = h;
      return unsubscribes.detected;
    },
    subscribeToTradeObserved: (h: (t: TokenTradeObserved) => void | Promise<void>) => {
      tradeHandler = h;
      return unsubscribes.trade;
    },
    subscribeToTrackingClosed: (h: (c: TokenTrackingClosed) => void | Promise<void>) => {
      closedHandler = h;
      return unsubscribes.closed;
    },
    publishAnalysisCompleted: (a: TokenWithFullContext) => {
      published.push(a);
    },
    rugcheckClient: client,
    clock,
    logger: silentLogger(),
    signal,
  };
  wireEnrichment(cooldownMs === undefined ? baseDeps : { ...baseDeps, cooldownMs });

  return {
    fireDetected: (t) => {
      if (detectedHandler === null) throw new Error('detected handler not registered');
      void detectedHandler(t);
    },
    fireTrade: async (t) => {
      if (tradeHandler === null) throw new Error('trade handler not registered');
      const result = tradeHandler(t);
      if (result instanceof Promise) await result;
      await drainMicrotasks();
    },
    fireClosed: (c) => {
      if (closedHandler === null) throw new Error('closed handler not registered');
      void closedHandler(c);
    },
    published,
    fetchReportMock: client.fetchReport as ReturnType<typeof vi.fn>,
    unsubscribes,
  };
};

const drainMicrotasks = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe('wireEnrichment', () => {
  test('caches detection but does not fire rugcheck until a trade arrives', async () => {
    const cap = wireWithCaptured([ok(sampleSnapshot())]);
    cap.fireDetected(sampleToken());
    await drainMicrotasks();

    expect(cap.fetchReportMock).not.toHaveBeenCalled();
    expect(cap.published).toHaveLength(0);
  });

  test('first trade triggers rugcheck and publishes ok on success', async () => {
    const cap = wireWithCaptured([ok(sampleSnapshot())]);
    cap.fireDetected(sampleToken());
    await cap.fireTrade(sampleTrade());

    expect(cap.fetchReportMock).toHaveBeenCalledTimes(1);
    expect(cap.published).toHaveLength(1);
    const a = cap.published[0];
    expect(a?.detected.mint).toBe('TestMint1234');
    expect(a?.rugcheck.kind).toBe('ok');
  });

  test('subsequent trades for an already-succeeded mint do not re-fire rugcheck', async () => {
    const cap = wireWithCaptured([ok(sampleSnapshot())]);
    cap.fireDetected(sampleToken());
    await cap.fireTrade(sampleTrade());
    await cap.fireTrade(sampleTrade({ signature: 'sig-2' }));
    await cap.fireTrade(sampleTrade({ signature: 'sig-3' }));

    expect(cap.fetchReportMock).toHaveBeenCalledTimes(1);
    expect(cap.published).toHaveLength(1);
  });

  test('failed attempt does not publish; cooldown blocks immediate retry', async () => {
    const cap = wireWithCaptured(
      [err({ kind: 'http_error', status: 400 }), ok(sampleSnapshot())],
      makeClock(0),
      undefined,
      1_500,
    );
    cap.fireDetected(sampleToken());
    await cap.fireTrade(sampleTrade());
    await cap.fireTrade(sampleTrade({ signature: 'sig-2' }));

    expect(cap.fetchReportMock).toHaveBeenCalledTimes(1);
    expect(cap.published).toHaveLength(0);
  });

  test('failed attempt retries after cooldown elapses and publishes on success', async () => {
    let now = 0;
    const clock: Clock = {
      now: () => FIXED_DATE,
      monotonicMs: () => now,
      sleep: () => Promise.resolve(),
    };
    const cap = wireWithCaptured(
      [err({ kind: 'http_error', status: 400 }), ok(sampleSnapshot())],
      clock,
      undefined,
      1_500,
    );
    cap.fireDetected(sampleToken());
    await cap.fireTrade(sampleTrade());

    now = 2_000;
    await cap.fireTrade(sampleTrade({ signature: 'sig-2' }));

    expect(cap.fetchReportMock).toHaveBeenCalledTimes(2);
    expect(cap.published).toHaveLength(1);
    expect(cap.published[0]?.rugcheck.kind).toBe('ok');
  });

  test('publishes final err at tracking_closed when enrichment never succeeded', async () => {
    const cap = wireWithCaptured([err({ kind: 'http_error', status: 400 })]);
    cap.fireDetected(sampleToken());
    await cap.fireTrade(sampleTrade());

    expect(cap.published).toHaveLength(0);

    cap.fireClosed(sampleTrackingClosed());

    expect(cap.published).toHaveLength(1);
    const a = cap.published[0];
    expect(a?.rugcheck.kind).toBe('err');
    if (a?.rugcheck.kind === 'err') {
      expect(a.rugcheck.error.kind).toBe('http_error');
    }
  });

  test('publishes synthetic err at tracking_closed for tokens that never traded', () => {
    const cap = wireWithCaptured([ok(sampleSnapshot())]);
    cap.fireDetected(sampleToken());
    cap.fireClosed(sampleTrackingClosed());

    expect(cap.fetchReportMock).not.toHaveBeenCalled();
    expect(cap.published).toHaveLength(1);
    const a = cap.published[0];
    expect(a?.rugcheck.kind).toBe('err');
    if (a?.rugcheck.kind === 'err') {
      expect(a.rugcheck.error.kind).toBe('network_error');
    }
  });

  test('does not re-publish at tracking_closed if enrichment already succeeded', async () => {
    const cap = wireWithCaptured([ok(sampleSnapshot())]);
    cap.fireDetected(sampleToken());
    await cap.fireTrade(sampleTrade());
    cap.fireClosed(sampleTrackingClosed());

    expect(cap.published).toHaveLength(1);
    expect(cap.published[0]?.rugcheck.kind).toBe('ok');
  });

  test('evicts state on tracking_closed so future trades for the same mint are ignored', async () => {
    const cap = wireWithCaptured([err({ kind: 'http_error', status: 400 }), ok(sampleSnapshot())]);
    cap.fireDetected(sampleToken());
    cap.fireClosed(sampleTrackingClosed());

    await cap.fireTrade(sampleTrade());

    expect(cap.fetchReportMock).not.toHaveBeenCalled();
  });

  test('duplicate detection for the same mint is a no-op', async () => {
    const cap = wireWithCaptured([ok(sampleSnapshot())]);
    cap.fireDetected(sampleToken());
    cap.fireDetected(sampleToken({ internalId: 'different-internal-id' }));
    await cap.fireTrade(sampleTrade());

    expect(cap.published).toHaveLength(1);
    expect(cap.published[0]?.detected.internalId).toBe('test-internal-1');
  });

  test('trade for unknown mint is silently ignored (no detection cached)', async () => {
    const cap = wireWithCaptured([ok(sampleSnapshot())]);
    await cap.fireTrade(sampleTrade({ mint: 'UnknownMint' }));

    expect(cap.fetchReportMock).not.toHaveBeenCalled();
    expect(cap.published).toHaveLength(0);
  });

  test('signal abort unsubscribes all three handlers', () => {
    const ctrl = new AbortController();
    const cap = wireWithCaptured([ok(sampleSnapshot())], makeClock(), ctrl.signal);

    expect(cap.unsubscribes.detected).not.toHaveBeenCalled();
    ctrl.abort();
    expect(cap.unsubscribes.detected).toHaveBeenCalledTimes(1);
    expect(cap.unsubscribes.trade).toHaveBeenCalledTimes(1);
    expect(cap.unsubscribes.closed).toHaveBeenCalledTimes(1);
  });

  test('does not subscribe when signal is already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const subscribeDetected = vi.fn();
    const subscribeTrade = vi.fn();
    const subscribeClosed = vi.fn();

    wireEnrichment({
      subscribeToDetectedTokens: subscribeDetected as never,
      subscribeToTradeObserved: subscribeTrade as never,
      subscribeToTrackingClosed: subscribeClosed as never,
      publishAnalysisCompleted: () => {},
      rugcheckClient: stubClient([ok(sampleSnapshot())]),
      clock: makeClock(),
      logger: silentLogger(),
      signal: ctrl.signal,
    });

    expect(subscribeDetected).not.toHaveBeenCalled();
    expect(subscribeTrade).not.toHaveBeenCalled();
    expect(subscribeClosed).not.toHaveBeenCalled();
  });

  test('does not publish if signal aborts between fetch and publish', async () => {
    const ctrl = new AbortController();
    const slowClient: RugCheckClient = {
      fetchReport: async () => {
        ctrl.abort();
        return ok(sampleSnapshot());
      },
    };
    const published: TokenWithFullContext[] = [];
    const handlers: {
      detected: ((t: DetectedToken) => void | Promise<void>) | null;
      trade: ((t: TokenTradeObserved) => void | Promise<void>) | null;
    } = { detected: null, trade: null };

    wireEnrichment({
      subscribeToDetectedTokens: (h) => {
        handlers.detected = h;
        return () => {};
      },
      subscribeToTradeObserved: (h) => {
        handlers.trade = h;
        return () => {};
      },
      subscribeToTrackingClosed: () => () => {},
      publishAnalysisCompleted: (a) => {
        published.push(a);
      },
      rugcheckClient: slowClient,
      clock: makeClock(),
      logger: silentLogger(),
      signal: ctrl.signal,
    });

    handlers.detected?.(sampleToken());
    await handlers.trade?.(sampleTrade());
    await drainMicrotasks();

    expect(published).toHaveLength(0);
  });

  test('integration: full lifecycle through a real event bus', async () => {
    const bus = createEventBus<EventMap>();
    const received: TokenWithFullContext[] = [];
    bus.subscribe('tokenAnalysisCompleted', (a) => {
      received.push(a);
    });
    const ctrl = new AbortController();

    wireEnrichment({
      subscribeToDetectedTokens: (h) => bus.subscribe('newTokenLaunchDetected', h),
      subscribeToTradeObserved: (h) => bus.subscribe('tokenTradeObserved', h),
      subscribeToTrackingClosed: (h) => bus.subscribe('tokenTrackingClosed', h),
      publishAnalysisCompleted: (a) => bus.publish('tokenAnalysisCompleted', a),
      rugcheckClient: stubClient([ok(sampleSnapshot())]),
      clock: makeClock(),
      logger: silentLogger(),
      signal: ctrl.signal,
    });

    bus.publish('newTokenLaunchDetected', sampleToken());
    await drainMicrotasks();
    bus.publish('tokenTradeObserved', sampleTrade());
    await drainMicrotasks();
    await drainMicrotasks();

    expect(received).toHaveLength(1);
    expect(received[0]?.rugcheck.kind).toBe('ok');
  });
});
