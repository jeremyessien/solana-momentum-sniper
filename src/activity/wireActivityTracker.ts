import type { Clock } from '../infrastructure/clock/clock.js';
import type { Logger } from '../infrastructure/logger/logger.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import type { ProgramLogEvent } from '../shared/programLogEvent.js';
import type {
  TokenTrackingClosed,
  TokenTrackingCloseReason,
} from '../shared/tokenTrackingClosed.js';
import type { TokenTradeObserved } from '../shared/tokenTradeObserved.js';
import { type ParsedTradeEvent, parsePumpfunActivityEvents } from './pumpfunTradeParser.js';

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_BUFFER_MAX_AGE_MS = 5_000;
const DEFAULT_BUFFER_MAX_SIZE = 200;

export type SubscribeToDetectedTokens = (handler: (token: DetectedToken) => void) => () => void;

export type SubscribeToRawLogs = (handler: (event: ProgramLogEvent) => void) => () => void;

export type PublishTradeObserved = (event: TokenTradeObserved) => void;
export type PublishTrackingClosed = (event: TokenTrackingClosed) => void;

export type WireActivityTrackerDeps = {
  readonly subscribeToDetectedTokens: SubscribeToDetectedTokens;
  readonly subscribeToRawLogs: SubscribeToRawLogs;
  readonly publishTradeObserved: PublishTradeObserved;
  readonly publishTrackingClosed: PublishTrackingClosed;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly maxAgeMs?: number;
  readonly bufferMaxAgeMs?: number;
  readonly bufferMaxSize?: number;
};

type TrackedTokenState = {
  readonly tokenInternalId: string;
  readonly mint: string;
  readonly creatorWallet: string;
  readonly trackingStartedAt: Date;
  maxAgeHandle: ReturnType<typeof setTimeout>;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  readonly traders: Set<string>;
  creatorTraded: boolean;
  firstTradeSlot: bigint | null;
  lastTradeSlot: bigint | null;
};

type UntrackedTradeBufferEntry = {
  readonly mint: string;
  readonly event: ParsedTradeEvent;
  readonly slot: bigint;
  readonly signature: string;
  readonly observedAt: Date;
  readonly bufferAddedAtMs: number;
};

export const wireActivityTracker = (deps: WireActivityTrackerDeps): void => {
  if (deps.signal.aborted) return;

  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const bufferMaxAgeMs = deps.bufferMaxAgeMs ?? DEFAULT_BUFFER_MAX_AGE_MS;
  const bufferMaxSize = deps.bufferMaxSize ?? DEFAULT_BUFFER_MAX_SIZE;

  const tracked = new Map<string, TrackedTokenState>();
  const untrackedBuffer: UntrackedTradeBufferEntry[] = [];

  const pruneBuffer = (): void => {
    const cutoff = deps.clock.monotonicMs() - bufferMaxAgeMs;
    while (untrackedBuffer.length > 0) {
      const head = untrackedBuffer[0];
      if (head === undefined || head.bufferAddedAtMs >= cutoff) break;
      untrackedBuffer.shift();
    }
    while (untrackedBuffer.length > bufferMaxSize) {
      untrackedBuffer.shift();
    }
  };

  const accumulateTrade = (
    state: TrackedTokenState,
    trade: ParsedTradeEvent,
    slot: bigint,
    signature: string,
    observedAt: Date,
  ): void => {
    state.tradeCount++;
    if (trade.isBuy) state.buyCount++;
    else state.sellCount++;
    state.traders.add(trade.user);
    if (trade.user === state.creatorWallet) state.creatorTraded = true;
    if (state.firstTradeSlot === null) state.firstTradeSlot = slot;
    state.lastTradeSlot = slot;

    deps.publishTradeObserved({
      tokenInternalId: state.tokenInternalId,
      mint: state.mint,
      trader: trade.user,
      isBuy: trade.isBuy,
      solAmount: trade.solAmount,
      tokenAmount: trade.tokenAmount,
      virtualSolReserves: trade.virtualSolReserves,
      virtualTokenReserves: trade.virtualTokenReserves,
      slot,
      signature,
      observedAt,
      pumpFunTimestamp: trade.timestamp,
    });
  };

  const closeTracking = (state: TrackedTokenState, reason: TokenTrackingCloseReason): void => {
    clearTimeout(state.maxAgeHandle);
    tracked.delete(state.mint);
    deps.publishTrackingClosed({
      tokenInternalId: state.tokenInternalId,
      mint: state.mint,
      closedAt: deps.clock.now(),
      reason,
      tradeCount: state.tradeCount,
      buyCount: state.buyCount,
      sellCount: state.sellCount,
      uniqueTraders: state.traders.size,
      creatorTraded: state.creatorTraded,
      firstTradeSlot: state.firstTradeSlot,
      lastTradeSlot: state.lastTradeSlot,
    });
    deps.logger.info(
      {
        mint: state.mint,
        internalId: state.tokenInternalId,
        reason,
        tradeCount: state.tradeCount,
        uniqueTraders: state.traders.size,
      },
      'activity tracking closed',
    );
  };

  const onDetectedToken = (token: DetectedToken): void => {
    if (tracked.has(token.mint)) return;

    const maxAgeHandle = setTimeout(() => {
      const state = tracked.get(token.mint);
      if (state !== undefined) closeTracking(state, 'timeout');
    }, maxAgeMs);

    const state: TrackedTokenState = {
      tokenInternalId: token.internalId,
      mint: token.mint,
      creatorWallet: token.creatorWallet,
      trackingStartedAt: deps.clock.now(),
      maxAgeHandle,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      traders: new Set(),
      creatorTraded: false,
      firstTradeSlot: null,
      lastTradeSlot: null,
    };
    tracked.set(token.mint, state);

    pruneBuffer();
    const replay: UntrackedTradeBufferEntry[] = [];
    const remaining: UntrackedTradeBufferEntry[] = [];
    for (const entry of untrackedBuffer) {
      if (entry.mint === token.mint) replay.push(entry);
      else remaining.push(entry);
    }
    untrackedBuffer.length = 0;
    untrackedBuffer.push(...remaining);

    for (const entry of replay) {
      accumulateTrade(state, entry.event, entry.slot, entry.signature, entry.observedAt);
    }
  };

  const onRawLog = (event: ProgramLogEvent): void => {
    const parsed = parsePumpfunActivityEvents(event);
    if (parsed.length === 0) return;

    const observedAt = deps.clock.now();
    const nowMonotonic = deps.clock.monotonicMs();

    for (const item of parsed) {
      if (item.kind === 'trade') {
        const state = tracked.get(item.data.mint);
        if (state !== undefined) {
          accumulateTrade(state, item.data, event.slot, event.signature, observedAt);
        } else {
          pruneBuffer();
          untrackedBuffer.push({
            mint: item.data.mint,
            event: item.data,
            slot: event.slot,
            signature: event.signature,
            observedAt,
            bufferAddedAtMs: nowMonotonic,
          });
          while (untrackedBuffer.length > bufferMaxSize) untrackedBuffer.shift();
        }
      } else if (item.kind === 'complete') {
        const state = tracked.get(item.data.mint);
        if (state !== undefined) closeTracking(state, 'graduated');
      }
    }
  };

  const unsubscribeDetection = deps.subscribeToDetectedTokens(onDetectedToken);
  const unsubscribeRawLogs = deps.subscribeToRawLogs(onRawLog);

  const cleanup = (): void => {
    unsubscribeDetection();
    unsubscribeRawLogs();
    for (const state of tracked.values()) {
      clearTimeout(state.maxAgeHandle);
    }
    tracked.clear();
    untrackedBuffer.length = 0;
  };

  deps.signal.addEventListener('abort', cleanup, { once: true });
};
