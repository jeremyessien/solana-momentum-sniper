import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { DetectedToken } from '../shared/detectedToken.js';
import { err, ok } from '../shared/result.js';
import type { RugCheckSnapshot } from '../shared/rugCheckSnapshot.js';
import type { StrategyEvaluationResult } from '../shared/strategyEvaluationResult.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';
import {
  DATA_COLLECTION_STRATEGY_ID,
  DATA_COLLECTION_THRESHOLDS,
} from './dataCollectionStrategy.js';
import { wireStrategy } from './wireStrategy.js';

const silentLogger = pino({ level: 'silent' });
const evaluatedAt = new Date('2026-05-20T12:00:03Z');

const baseDetected: DetectedToken = {
  internalId: 'token-1',
  mint: 'mint-abc',
  launchpad: 'pumpfun',
  creatorWallet: 'creator-1',
  initialLiquidityLamports: 1_000_000_000n,
  detectedAt: new Date('2026-05-20T12:00:00Z'),
};

const baseSnapshot: RugCheckSnapshot = {
  snapshotAt: new Date('2026-05-20T12:00:01Z'),
  mint: 'mint-abc',
  score: 100,
  scoreNormalised: 20,
  risks: [],
  rugged: false,
  creatorBalance: 0n,
  mintAuthority: null,
  freezeAuthority: null,
  topHolders: [{ address: 'h1', owner: 'h1', amount: 0n, pct: 10, insider: false }],
  totalHolders: 100,
  totalMarketLiquidityUsd: 1000,
  tokenName: 'Test',
  tokenSymbol: 'TST',
  rawJson: '{}',
};

const buildAnalysis = (overrides: Partial<RugCheckSnapshot> = {}): TokenWithFullContext => ({
  detected: baseDetected,
  analyzedAt: new Date('2026-05-20T12:00:02Z'),
  rugcheck: ok({ ...baseSnapshot, ...overrides }),
});

const setup = (opts: { signalAborted?: boolean } = {}) => {
  let triggerAnalysis: (analysis: TokenWithFullContext) => void = () => {};
  const unsubscribeMock = vi.fn();
  const subscribeToAnalysisCompleted = vi.fn(
    (handler: (analysis: TokenWithFullContext) => void) => {
      triggerAnalysis = handler;
      return unsubscribeMock;
    },
  );
  const publishStrategyDecision = vi.fn<(decision: StrategyEvaluationResult) => void>();
  const ctrl = new AbortController();
  if (opts.signalAborted) ctrl.abort();

  wireStrategy({
    subscribeToAnalysisCompleted,
    publishStrategyDecision,
    clock: {
      now: () => evaluatedAt,
      monotonicMs: () => 0,
      sleep: () => Promise.resolve(),
    },
    logger: silentLogger,
    signal: ctrl.signal,
  });

  return {
    triggerAnalysis: (a: TokenWithFullContext) => triggerAnalysis(a),
    subscribeToAnalysisCompleted,
    publishStrategyDecision,
    unsubscribeMock,
    ctrl,
  };
};

describe('wireStrategy', () => {
  it('publishes a fully-assembled decision when an analysis arrives', () => {
    const h = setup();
    const analysis = buildAnalysis({
      scoreNormalised: 25,
      topHolders: [{ address: 'a', owner: 'a', amount: 0n, pct: 15, insider: false }],
    });

    h.triggerAnalysis(analysis);

    expect(h.publishStrategyDecision).toHaveBeenCalledTimes(1);
    expect(h.publishStrategyDecision.mock.calls[0]?.[0]).toEqual({
      strategyId: DATA_COLLECTION_STRATEGY_ID,
      candidate: analysis,
      thresholds: DATA_COLLECTION_THRESHOLDS,
      decision: { kind: 'enter' },
      evaluatedAt,
    });
  });

  it('publishes a Pass when the candidate is rugged', () => {
    const h = setup();
    h.triggerAnalysis(buildAnalysis({ rugged: true }));
    expect(h.publishStrategyDecision.mock.calls[0]?.[0]?.decision).toEqual({
      kind: 'pass',
      reasons: ['rugged'],
    });
  });

  it('publishes a Pass with rugcheck_failed when rugcheck is an err', () => {
    const h = setup();
    h.triggerAnalysis({
      detected: baseDetected,
      analyzedAt: new Date('2026-05-20T12:00:02Z'),
      rugcheck: err({ kind: 'http_error', status: 400 }),
    });
    expect(h.publishStrategyDecision.mock.calls[0]?.[0]?.decision).toEqual({
      kind: 'pass',
      reasons: ['rugcheck_failed'],
    });
  });

  it('does not subscribe if signal is already aborted', () => {
    const h = setup({ signalAborted: true });
    expect(h.subscribeToAnalysisCompleted).not.toHaveBeenCalled();
    expect(h.publishStrategyDecision).not.toHaveBeenCalled();
  });

  it('unsubscribes when signal aborts', () => {
    const h = setup();
    expect(h.unsubscribeMock).not.toHaveBeenCalled();
    h.ctrl.abort();
    expect(h.unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
