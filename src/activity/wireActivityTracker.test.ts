import { describe, expect, test, vi } from 'vitest';
import type { Clock } from '../infrastructure/clock/clock.js';
import { createEventBus } from '../infrastructure/eventBus/eventBus.js';
import { createLogger, type Logger } from '../infrastructure/logger/logger.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import type { EventMap } from '../shared/eventMap.js';
import type { ProgramLogEvent } from '../shared/programLogEvent.js';
import type { TokenTrackingClosed } from '../shared/tokenTrackingClosed.js';
import type { TokenTradeObserved } from '../shared/tokenTradeObserved.js';
import { parsePumpfunActivityEvents } from './pumpfunTradeParser.js';
import { wireActivityTracker } from './wireActivityTracker.js';

const FIXED_DATE = new Date('2026-05-11T12:00:00Z');

const makeAdvancingClock = (): { clock: Clock; advance: (ms: number) => void } => {
  let mono = 0;
  return {
    clock: {
      now: () => FIXED_DATE,
      monotonicMs: () => mono,
      sleep: () => Promise.resolve(),
    },
    advance: (ms) => {
      mono += ms;
    },
  };
};

const silentLogger = (): Logger =>
  createLogger({ level: 'error', isDevelopment: false }, { write: () => {} });

const sampleToken = (overrides: Partial<DetectedToken> = {}): DetectedToken => ({
  internalId: 'internal-1',
  mint: 'MintAAA',
  launchpad: 'pumpfun',
  creatorWallet: 'CreatorXYZ',
  initialLiquidityLamports: 1_000_000_000n,
  detectedAt: FIXED_DATE,
  ...overrides,
});

const buildTradeLog = (params: {
  mintByte: number;
  userByte: number;
  isBuy: boolean;
  solAmount: bigint;
  tokenAmount: bigint;
}): string => {
  const discriminator = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
  const mint = Buffer.alloc(32, params.mintByte);
  const solAmount = Buffer.alloc(8);
  solAmount.writeBigUInt64LE(params.solAmount);
  const tokenAmount = Buffer.alloc(8);
  tokenAmount.writeBigUInt64LE(params.tokenAmount);
  const isBuy = Buffer.from([params.isBuy ? 1 : 0]);
  const user = Buffer.alloc(32, params.userByte);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigInt64LE(1_700_000_000n);
  const vSol = Buffer.alloc(8);
  vSol.writeBigUInt64LE(100n);
  const vTok = Buffer.alloc(8);
  vTok.writeBigUInt64LE(100n);
  const payload = Buffer.concat([
    discriminator,
    mint,
    solAmount,
    tokenAmount,
    isBuy,
    user,
    timestamp,
    vSol,
    vTok,
  ]);
  return `Program data: ${payload.toString('base64')}`;
};

const buildCompleteLog = (params: { mintByte: number; userByte: number }): string => {
  const discriminator = Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]);
  const user = Buffer.alloc(32, params.userByte);
  const mint = Buffer.alloc(32, params.mintByte);
  const bondingCurve = Buffer.alloc(32, 0x77);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigInt64LE(1_700_000_000n);
  const payload = Buffer.concat([discriminator, user, mint, bondingCurve, timestamp]);
  return `Program data: ${payload.toString('base64')}`;
};

const tradeFixture = (params: {
  mintByte: number;
  userByte: number;
  isBuy: boolean;
  solAmount?: bigint;
  tokenAmount?: bigint;
}): { log: string; expectedMint: string; expectedUser: string } => {
  const log = buildTradeLog({
    mintByte: params.mintByte,
    userByte: params.userByte,
    isBuy: params.isBuy,
    solAmount: params.solAmount ?? 1_000_000n,
    tokenAmount: params.tokenAmount ?? 5_000n,
  });
  const event: ProgramLogEvent = { signature: 's', slot: 1n, logs: [log], err: null };
  const parsed = parsePumpfunActivityEvents(event);
  const trade = parsed.find((p) => p.kind === 'trade');
  if (!trade || trade.kind !== 'trade') {
    throw new Error('tradeFixture parser self-check failed');
  }
  return { log, expectedMint: trade.data.mint, expectedUser: trade.data.user };
};

const completeFixture = (params: {
  mintByte: number;
  userByte: number;
}): { log: string; expectedMint: string } => {
  const log = buildCompleteLog(params);
  const event: ProgramLogEvent = { signature: 's', slot: 1n, logs: [log], err: null };
  const parsed = parsePumpfunActivityEvents(event);
  const complete = parsed.find((p) => p.kind === 'complete');
  if (!complete || complete.kind !== 'complete') {
    throw new Error('completeFixture parser self-check failed');
  }
  return { log, expectedMint: complete.data.mint };
};

const programLogEvent = (
  logs: readonly string[],
  slot = 100n,
  signature = 'sig',
): ProgramLogEvent => ({
  signature,
  slot,
  logs,
  err: null,
});

describe('wireActivityTracker', () => {
  test('happy path: detection then trade publishes a tokenTradeObserved', () => {
    const fixture = tradeFixture({ mintByte: 0xaa, userByte: 0xbb, isBuy: true });
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const rawHandlers: Array<(e: ProgramLogEvent) => void> = [];
    const trades: TokenTradeObserved[] = [];
    const { clock } = makeAdvancingClock();

    wireActivityTracker({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToRawLogs: (h) => {
        rawHandlers.push(h);
        return () => {};
      },
      publishTradeObserved: (e) => trades.push(e),
      publishTrackingClosed: () => {},
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
      maxAgeMs: 60_000,
    });

    detectionHandlers[0]?.(sampleToken({ mint: fixture.expectedMint }));
    rawHandlers[0]?.(programLogEvent([fixture.log]));

    expect(trades).toHaveLength(1);
    expect(trades[0]?.mint).toBe(fixture.expectedMint);
    expect(trades[0]?.trader).toBe(fixture.expectedUser);
    expect(trades[0]?.isBuy).toBe(true);
    expect(trades[0]?.solAmount).toBe(1_000_000n);
  });

  test('race fix: trade arrives before detection, buffered, replayed when detection lands', () => {
    const fixture = tradeFixture({ mintByte: 0xcc, userByte: 0xdd, isBuy: true });
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const rawHandlers: Array<(e: ProgramLogEvent) => void> = [];
    const trades: TokenTradeObserved[] = [];
    const { clock } = makeAdvancingClock();

    wireActivityTracker({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToRawLogs: (h) => {
        rawHandlers.push(h);
        return () => {};
      },
      publishTradeObserved: (e) => trades.push(e),
      publishTrackingClosed: () => {},
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
      maxAgeMs: 60_000,
    });

    rawHandlers[0]?.(programLogEvent([fixture.log]));
    expect(trades).toHaveLength(0);

    detectionHandlers[0]?.(sampleToken({ mint: fixture.expectedMint }));
    expect(trades).toHaveLength(1);
    expect(trades[0]?.mint).toBe(fixture.expectedMint);
  });

  test('buffered trades age out after bufferMaxAgeMs', () => {
    const fixture = tradeFixture({ mintByte: 0xee, userByte: 0xff, isBuy: true });
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const rawHandlers: Array<(e: ProgramLogEvent) => void> = [];
    const trades: TokenTradeObserved[] = [];
    const { clock, advance } = makeAdvancingClock();

    wireActivityTracker({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToRawLogs: (h) => {
        rawHandlers.push(h);
        return () => {};
      },
      publishTradeObserved: (e) => trades.push(e),
      publishTrackingClosed: () => {},
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
      maxAgeMs: 60_000,
      bufferMaxAgeMs: 1_000,
    });

    rawHandlers[0]?.(programLogEvent([fixture.log]));
    advance(5_000);

    detectionHandlers[0]?.(sampleToken({ mint: fixture.expectedMint }));
    expect(trades).toHaveLength(0);
  });

  test('detection is idempotent against WS replay (no double-tracking, no double-close)', () => {
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const closed: TokenTrackingClosed[] = [];
    const { clock } = makeAdvancingClock();

    wireActivityTracker({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToRawLogs: () => () => {},
      publishTradeObserved: () => {},
      publishTrackingClosed: (e) => closed.push(e),
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
      maxAgeMs: 60_000,
    });

    const token = sampleToken();
    detectionHandlers[0]?.(token);
    detectionHandlers[0]?.(token);
    detectionHandlers[0]?.(token);

    expect(closed).toHaveLength(0);
  });

  test('signal abort calls both unsubscribe functions and clears state', () => {
    const ctrl = new AbortController();
    const unsubscribeDetection = vi.fn();
    const unsubscribeRawLogs = vi.fn();
    const { clock } = makeAdvancingClock();

    wireActivityTracker({
      subscribeToDetectedTokens: () => unsubscribeDetection,
      subscribeToRawLogs: () => unsubscribeRawLogs,
      publishTradeObserved: () => {},
      publishTrackingClosed: () => {},
      clock,
      logger: silentLogger(),
      signal: ctrl.signal,
      maxAgeMs: 60_000,
    });

    ctrl.abort();

    expect(unsubscribeDetection).toHaveBeenCalledTimes(1);
    expect(unsubscribeRawLogs).toHaveBeenCalledTimes(1);
  });

  test('max-age timeout fires publishTrackingClosed with reason timeout', async () => {
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const closed: TokenTrackingClosed[] = [];
    const { clock } = makeAdvancingClock();

    wireActivityTracker({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToRawLogs: () => () => {},
      publishTradeObserved: () => {},
      publishTrackingClosed: (e) => closed.push(e),
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
      maxAgeMs: 30,
    });

    detectionHandlers[0]?.(sampleToken());

    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    expect(closed).toHaveLength(1);
    expect(closed[0]?.reason).toBe('timeout');
    expect(closed[0]?.tradeCount).toBe(0);
  });

  test('CompleteEvent for tracked mint closes tracking with reason graduated', () => {
    const fixture = completeFixture({ mintByte: 0x11, userByte: 0x22 });
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const rawHandlers: Array<(e: ProgramLogEvent) => void> = [];
    const closed: TokenTrackingClosed[] = [];
    const { clock } = makeAdvancingClock();

    wireActivityTracker({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToRawLogs: (h) => {
        rawHandlers.push(h);
        return () => {};
      },
      publishTradeObserved: () => {},
      publishTrackingClosed: (e) => closed.push(e),
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
      maxAgeMs: 60_000,
    });

    detectionHandlers[0]?.(sampleToken({ mint: fixture.expectedMint }));
    rawHandlers[0]?.(programLogEvent([fixture.log]));

    expect(closed).toHaveLength(1);
    expect(closed[0]?.reason).toBe('graduated');
    expect(closed[0]?.mint).toBe(fixture.expectedMint);
  });

  test('creatorTraded becomes true when the creator wallet trades during tracking', () => {
    const fixture = tradeFixture({ mintByte: 0x44, userByte: 0x55, isBuy: true });
    const detectionHandlers: Array<(t: DetectedToken) => void> = [];
    const rawHandlers: Array<(e: ProgramLogEvent) => void> = [];
    const closed: TokenTrackingClosed[] = [];
    const completeFx = completeFixture({ mintByte: 0x44, userByte: 0x99 });
    const { clock } = makeAdvancingClock();

    wireActivityTracker({
      subscribeToDetectedTokens: (h) => {
        detectionHandlers.push(h);
        return () => {};
      },
      subscribeToRawLogs: (h) => {
        rawHandlers.push(h);
        return () => {};
      },
      publishTradeObserved: () => {},
      publishTrackingClosed: (e) => closed.push(e),
      clock,
      logger: silentLogger(),
      signal: new AbortController().signal,
      maxAgeMs: 60_000,
    });

    detectionHandlers[0]?.(
      sampleToken({ mint: fixture.expectedMint, creatorWallet: fixture.expectedUser }),
    );
    rawHandlers[0]?.(programLogEvent([fixture.log]));
    rawHandlers[0]?.(programLogEvent([completeFx.log]));

    expect(closed).toHaveLength(1);
    expect(closed[0]?.creatorTraded).toBe(true);
    expect(closed[0]?.tradeCount).toBe(1);
    expect(closed[0]?.buyCount).toBe(1);
  });

  test('integration: real event bus dispatches detection and trade to wireActivityTracker', async () => {
    const fixture = tradeFixture({ mintByte: 0x66, userByte: 0x77, isBuy: true });
    const bus = createEventBus<EventMap>();
    const trades: TokenTradeObserved[] = [];

    bus.subscribe('tokenTradeObserved', (e) => {
      trades.push(e);
    });

    const ctrl = new AbortController();
    const { clock } = makeAdvancingClock();
    wireActivityTracker({
      subscribeToDetectedTokens: (h) => bus.subscribe('newTokenLaunchDetected', h),
      subscribeToRawLogs: (h) => bus.subscribe('rawProgramLogReceived', h),
      publishTradeObserved: (e) => bus.publish('tokenTradeObserved', e),
      publishTrackingClosed: (e) => bus.publish('tokenTrackingClosed', e),
      clock,
      logger: silentLogger(),
      signal: ctrl.signal,
      maxAgeMs: 60_000,
    });

    bus.publish(
      'newTokenLaunchDetected',
      sampleToken({ mint: fixture.expectedMint, internalId: 'i-int' }),
    );
    bus.publish('rawProgramLogReceived', {
      signature: 'sig',
      slot: 100n,
      logs: [fixture.log],
      err: null,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(trades).toHaveLength(1);
    expect(trades[0]?.mint).toBe(fixture.expectedMint);
    expect(trades[0]?.tokenInternalId).toBe('i-int');
  });
});
