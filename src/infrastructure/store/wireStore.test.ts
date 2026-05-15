import pino from 'pino';
import { describe, expect, test, vi } from 'vitest';
import type { DetectedToken } from '../../shared/detectedToken.js';
import { ok } from '../../shared/result.js';
import type { RugCheckSnapshot } from '../../shared/rugCheckSnapshot.js';
import type { TokenTrackingClosed } from '../../shared/tokenTrackingClosed.js';
import type { TokenTradeObserved } from '../../shared/tokenTradeObserved.js';
import type { TokenWithFullContext } from '../../shared/tokenWithFullContext.js';
import type { EventStore } from './eventStore.js';
import { wireStore } from './wireStore.js';

const silentLogger = pino({ level: 'silent' });

type Subscribers = {
  detected: ((t: DetectedToken) => void) | null;
  analyzed: ((a: TokenWithFullContext) => void) | null;
  trade: ((t: TokenTradeObserved) => void) | null;
  closed: ((c: TokenTrackingClosed) => void) | null;
};

const createSubscribers = (): {
  subs: Subscribers;
  wireDeps: {
    subscribeToDetectedTokens: (h: (t: DetectedToken) => void) => () => void;
    subscribeToAnalysisCompleted: (h: (a: TokenWithFullContext) => void) => () => void;
    subscribeToTradeObserved: (h: (t: TokenTradeObserved) => void) => () => void;
    subscribeToTrackingClosed: (h: (c: TokenTrackingClosed) => void) => () => void;
  };
} => {
  const subs: Subscribers = { detected: null, analyzed: null, trade: null, closed: null };
  return {
    subs,
    wireDeps: {
      subscribeToDetectedTokens: (h) => {
        subs.detected = h;
        return () => {
          subs.detected = null;
        };
      },
      subscribeToAnalysisCompleted: (h) => {
        subs.analyzed = h;
        return () => {
          subs.analyzed = null;
        };
      },
      subscribeToTradeObserved: (h) => {
        subs.trade = h;
        return () => {
          subs.trade = null;
        };
      },
      subscribeToTrackingClosed: (h) => {
        subs.closed = h;
        return () => {
          subs.closed = null;
        };
      },
    },
  };
};

const fakeEventStore = (): EventStore => ({
  recordDetection: vi.fn(),
  recordAnalysisCompleted: vi.fn(),
  recordTradeObserved: vi.fn(),
  recordTrackingClosed: vi.fn(),
  pruneTradesOlderThan: vi.fn().mockReturnValue({ rowsDeleted: 0 }),
  close: vi.fn(),
});

const exampleDetection = (): DetectedToken => ({
  internalId: 'tok-1',
  mint: 'Mint1',
  launchpad: 'pumpfun',
  creatorWallet: 'Creator1',
  initialLiquidityLamports: 1n,
  detectedAt: new Date(0),
});

const exampleAnalysis = (): TokenWithFullContext => ({
  detected: exampleDetection(),
  analyzedAt: new Date(0),
  rugcheck: ok({} as RugCheckSnapshot),
});

const exampleTrade = (): TokenTradeObserved => ({
  tokenInternalId: 'tok-1',
  mint: 'Mint1',
  trader: 'Trader1',
  isBuy: true,
  solAmount: 1n,
  tokenAmount: 1n,
  virtualSolReserves: 1n,
  virtualTokenReserves: 1n,
  slot: 1n,
  signature: 'sig-1',
  observedAt: new Date(0),
  pumpFunTimestamp: 0n,
});

const exampleClosed = (): TokenTrackingClosed => ({
  tokenInternalId: 'tok-1',
  mint: 'Mint1',
  closedAt: new Date(0),
  reason: 'graduated',
  tradeCount: 0,
  buyCount: 0,
  sellCount: 0,
  uniqueTraders: 0,
  creatorTraded: false,
  firstTradeSlot: null,
  lastTradeSlot: null,
});

describe('wireStore', () => {
  test('routes each bus event to the matching store method', () => {
    const { subs, wireDeps } = createSubscribers();
    const eventStore = fakeEventStore();
    const ctrl = new AbortController();

    wireStore({ ...wireDeps, eventStore, logger: silentLogger, signal: ctrl.signal });

    const detection = exampleDetection();
    const analysis = exampleAnalysis();
    const trade = exampleTrade();
    const closed = exampleClosed();

    subs.detected?.(detection);
    subs.analyzed?.(analysis);
    subs.trade?.(trade);
    subs.closed?.(closed);

    expect(eventStore.recordDetection).toHaveBeenCalledWith(detection);
    expect(eventStore.recordAnalysisCompleted).toHaveBeenCalledWith(analysis);
    expect(eventStore.recordTradeObserved).toHaveBeenCalledWith(trade);
    expect(eventStore.recordTrackingClosed).toHaveBeenCalledWith(closed);
  });

  test('does not subscribe if signal is already aborted', () => {
    const { subs, wireDeps } = createSubscribers();
    const eventStore = fakeEventStore();
    const ctrl = new AbortController();
    ctrl.abort();

    wireStore({ ...wireDeps, eventStore, logger: silentLogger, signal: ctrl.signal });

    expect(subs.detected).toBeNull();
    expect(subs.analyzed).toBeNull();
    expect(subs.trade).toBeNull();
    expect(subs.closed).toBeNull();
  });

  test('unsubscribes all subscriptions on abort', () => {
    const { subs, wireDeps } = createSubscribers();
    const eventStore = fakeEventStore();
    const ctrl = new AbortController();

    wireStore({ ...wireDeps, eventStore, logger: silentLogger, signal: ctrl.signal });

    expect(subs.detected).not.toBeNull();
    ctrl.abort();
    expect(subs.detected).toBeNull();
    expect(subs.analyzed).toBeNull();
    expect(subs.trade).toBeNull();
    expect(subs.closed).toBeNull();
  });

  test('store errors do not propagate; they are logged and swallowed', () => {
    const { subs, wireDeps } = createSubscribers();
    const eventStore = fakeEventStore();
    (eventStore.recordDetection as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('disk full');
    });
    const ctrl = new AbortController();

    wireStore({ ...wireDeps, eventStore, logger: silentLogger, signal: ctrl.signal });

    expect(() => subs.detected?.(exampleDetection())).not.toThrow();
  });

  test('failure on one handler does not prevent later handlers from running', () => {
    const { subs, wireDeps } = createSubscribers();
    const eventStore = fakeEventStore();
    (eventStore.recordDetection as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom');
    });
    const ctrl = new AbortController();

    wireStore({ ...wireDeps, eventStore, logger: silentLogger, signal: ctrl.signal });

    subs.detected?.(exampleDetection());
    subs.trade?.(exampleTrade());

    expect(eventStore.recordTradeObserved).toHaveBeenCalledTimes(1);
  });
});
