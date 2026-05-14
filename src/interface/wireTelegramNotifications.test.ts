import { describe, expect, test, vi } from 'vitest';
import type { Clock } from '../infrastructure/clock/clock.js';
import { createLogger, type Logger } from '../infrastructure/logger/logger.js';
import type { TelegramClient } from '../infrastructure/telegram/telegramClient.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import { ok } from '../shared/result.js';
import type { RugCheckSnapshot } from '../shared/rugCheckSnapshot.js';
import type { TokenTrackingClosed } from '../shared/tokenTrackingClosed.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';
import { wireTelegramNotifications } from './wireTelegramNotifications.js';

const silentLogger = (): Logger =>
  createLogger({ level: 'error', isDevelopment: false }, { write: () => {} });

const makeAdvancingClock = (): { clock: Clock; advance: (ms: number) => void } => {
  let mono = 0;
  return {
    clock: {
      now: () => new Date('2026-05-11T12:00:00Z'),
      monotonicMs: () => mono,
      sleep: () => Promise.resolve(),
    },
    advance: (ms) => {
      mono += ms;
    },
  };
};

const makeStubClient = (): { client: TelegramClient; sent: string[] } => {
  const sent: string[] = [];
  return {
    client: {
      sendMessage: vi.fn().mockImplementation(async (text: string) => {
        sent.push(text);
      }),
      getBotUsername: vi.fn().mockResolvedValue('stubbot'),
    },
    sent,
  };
};

const sampleToken = (overrides: Partial<DetectedToken> = {}): DetectedToken => ({
  internalId: 'int-1',
  mint: 'TestMint1234567890',
  launchpad: 'pumpfun',
  creatorWallet: 'Creator1234567890',
  initialLiquidityLamports: 1_000_000_000n,
  detectedAt: new Date('2026-05-11T12:00:00Z'),
  ...overrides,
});

const sampleSnapshot = (): RugCheckSnapshot => ({
  snapshotAt: new Date(),
  mint: 'TestMint1234567890',
  score: 1,
  scoreNormalised: 1,
  risks: [],
  rugged: false,
  creatorBalance: 0n,
  mintAuthority: null,
  freezeAuthority: null,
  topHolders: [],
  totalHolders: 100,
  totalMarketLiquidityUsd: 50000,
  tokenName: 'Test',
  tokenSymbol: 'TEST',
  rawJson: '{}',
});

const sampleAnalysis = (overrides: Partial<TokenWithFullContext> = {}): TokenWithFullContext => ({
  detected: sampleToken(),
  analyzedAt: new Date(),
  rugcheck: ok(sampleSnapshot()),
  ...overrides,
});

const sampleClosed = (overrides: Partial<TokenTrackingClosed> = {}): TokenTrackingClosed => ({
  tokenInternalId: 'int-1',
  mint: 'TestMint1234567890',
  closedAt: new Date(),
  reason: 'graduated',
  tradeCount: 5,
  buyCount: 3,
  sellCount: 2,
  uniqueTraders: 4,
  creatorTraded: false,
  firstTradeSlot: 100n,
  lastTradeSlot: 150n,
  ...overrides,
});

describe('wireTelegramNotifications', () => {
  test('forwards detection events as formatted messages', () => {
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const { client, sent } = makeStubClient();
    const { clock } = makeAdvancingClock();

    wireTelegramNotifications({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToAnalysisCompleted: () => () => {},
      subscribeToTrackingClosed: () => () => {},
      telegramClient: client,
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
    });

    detectionHandlers[0]?.(sampleToken());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('New launch');
    expect(sent[0]).toContain('TestMint1234567890');
  });

  test('forwards analysis events as formatted messages', () => {
    const analysisHandlers: Array<(a: TokenWithFullContext) => void> = [];
    const { client, sent } = makeStubClient();
    const { clock } = makeAdvancingClock();

    wireTelegramNotifications({
      subscribeToDetectedTokens: () => () => {},
      subscribeToAnalysisCompleted: (h) => {
        analysisHandlers.push(h);
        return () => {};
      },
      subscribeToTrackingClosed: () => () => {},
      telegramClient: client,
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
    });

    analysisHandlers[0]?.(sampleAnalysis());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Analysis');
    expect(sent[0]).toContain('$TEST');
  });

  test('forwards tracking-closed events as formatted messages', () => {
    const closedHandlers: Array<(c: TokenTrackingClosed) => void> = [];
    const { client, sent } = makeStubClient();
    const { clock } = makeAdvancingClock();

    wireTelegramNotifications({
      subscribeToDetectedTokens: () => () => {},
      subscribeToAnalysisCompleted: () => () => {},
      subscribeToTrackingClosed: (h) => {
        closedHandlers.push(h);
        return () => {};
      },
      telegramClient: client,
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
    });

    closedHandlers[0]?.(sampleClosed());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Tracking closed');
    expect(sent[0]).toContain('graduated');
  });

  test('does not subscribe when the signal is already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const subscribeDetected = vi.fn();
    const subscribeAnalyzed = vi.fn();
    const subscribeClosed = vi.fn();
    const { client } = makeStubClient();
    const { clock } = makeAdvancingClock();

    wireTelegramNotifications({
      subscribeToDetectedTokens: subscribeDetected as never,
      subscribeToAnalysisCompleted: subscribeAnalyzed as never,
      subscribeToTrackingClosed: subscribeClosed as never,
      telegramClient: client,
      clock,
      logger: silentLogger(),
      signal: ctrl.signal,
    });

    expect(subscribeDetected).not.toHaveBeenCalled();
    expect(subscribeAnalyzed).not.toHaveBeenCalled();
    expect(subscribeClosed).not.toHaveBeenCalled();
  });

  test('calls all three unsubscribe functions on signal abort', () => {
    const ctrl = new AbortController();
    const unsubscribeDetected = vi.fn();
    const unsubscribeAnalyzed = vi.fn();
    const unsubscribeClosed = vi.fn();
    const { client } = makeStubClient();
    const { clock } = makeAdvancingClock();

    wireTelegramNotifications({
      subscribeToDetectedTokens: () => unsubscribeDetected,
      subscribeToAnalysisCompleted: () => unsubscribeAnalyzed,
      subscribeToTrackingClosed: () => unsubscribeClosed,
      telegramClient: client,
      clock,
      logger: silentLogger(),
      signal: ctrl.signal,
    });

    ctrl.abort();

    expect(unsubscribeDetected).toHaveBeenCalledTimes(1);
    expect(unsubscribeAnalyzed).toHaveBeenCalledTimes(1);
    expect(unsubscribeClosed).toHaveBeenCalledTimes(1);
  });

  test('skips a duplicate detection within the dedup window', () => {
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const { client, sent } = makeStubClient();
    const { clock } = makeAdvancingClock();

    wireTelegramNotifications({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToAnalysisCompleted: () => () => {},
      subscribeToTrackingClosed: () => () => {},
      telegramClient: client,
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
      dedupWindowMs: 30_000,
    });

    detectionHandlers[0]?.(sampleToken({ mint: 'MintA' }));
    detectionHandlers[0]?.(sampleToken({ mint: 'MintA' }));
    detectionHandlers[0]?.(sampleToken({ mint: 'MintA' }));

    expect(sent).toHaveLength(1);
  });

  test('forwards a duplicate detection after the dedup window has elapsed', () => {
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const { client, sent } = makeStubClient();
    const { clock, advance } = makeAdvancingClock();

    wireTelegramNotifications({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToAnalysisCompleted: () => () => {},
      subscribeToTrackingClosed: () => () => {},
      telegramClient: client,
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
      dedupWindowMs: 1_000,
    });

    detectionHandlers[0]?.(sampleToken({ mint: 'MintA' }));
    advance(2_000);
    detectionHandlers[0]?.(sampleToken({ mint: 'MintA' }));

    expect(sent).toHaveLength(2);
  });

  test('does not dedup across different event types for the same mint', () => {
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const analysisHandlers: Array<(a: TokenWithFullContext) => void> = [];
    const closedHandlers: Array<(c: TokenTrackingClosed) => void> = [];
    const { client, sent } = makeStubClient();
    const { clock } = makeAdvancingClock();

    wireTelegramNotifications({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToAnalysisCompleted: (h) => {
        analysisHandlers.push(h);
        return () => {};
      },
      subscribeToTrackingClosed: (h) => {
        closedHandlers.push(h);
        return () => {};
      },
      telegramClient: client,
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
    });

    detectionHandlers[0]?.(sampleToken({ mint: 'MintA' }));
    analysisHandlers[0]?.(sampleAnalysis({ detected: sampleToken({ mint: 'MintA' }) }));
    closedHandlers[0]?.(sampleClosed({ mint: 'MintA' }));

    expect(sent).toHaveLength(3);
  });
});
