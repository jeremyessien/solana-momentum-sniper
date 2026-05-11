import {
  type Cursor,
  matchesDiscriminator,
  PROGRAM_DATA_PREFIX,
  readBool,
  readI64LE,
  readPubkey,
  readU64LE,
} from '../shared/borshCursor.js';
import type { ProgramLogEvent } from '../shared/programLogEvent.js';

const TRADE_EVENT_DISCRIMINATOR = new Uint8Array([189, 219, 127, 211, 78, 230, 97, 238]);
const COMPLETE_EVENT_DISCRIMINATOR = new Uint8Array([95, 114, 97, 156, 212, 46, 152, 8]);
const TRADE_EVENT_DISCRIMINATOR_BASE64_PREFIX = 'vdt/00';
const COMPLETE_EVENT_DISCRIMINATOR_BASE64_PREFIX = 'X3Jh';

export type ParsedTradeEvent = {
  readonly mint: string;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly isBuy: boolean;
  readonly user: string;
  readonly timestamp: bigint;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
};

export type ParsedCompleteEvent = {
  readonly user: string;
  readonly mint: string;
  readonly bondingCurve: string;
  readonly timestamp: bigint;
};

export type ParsedActivityEvent =
  | { readonly kind: 'trade'; readonly data: ParsedTradeEvent }
  | { readonly kind: 'complete'; readonly data: ParsedCompleteEvent };

const decodeTradeEvent = (bytes: Uint8Array): ParsedTradeEvent | null => {
  try {
    const cursor: Cursor = { bytes, offset: TRADE_EVENT_DISCRIMINATOR.length };
    const mint = readPubkey(cursor);
    const solAmount = readU64LE(cursor);
    const tokenAmount = readU64LE(cursor);
    const isBuy = readBool(cursor);
    const user = readPubkey(cursor);
    const timestamp = readI64LE(cursor);
    const virtualSolReserves = readU64LE(cursor);
    const virtualTokenReserves = readU64LE(cursor);
    return {
      mint,
      solAmount,
      tokenAmount,
      isBuy,
      user,
      timestamp,
      virtualSolReserves,
      virtualTokenReserves,
    };
  } catch {
    return null;
  }
};

const decodeCompleteEvent = (bytes: Uint8Array): ParsedCompleteEvent | null => {
  try {
    const cursor: Cursor = { bytes, offset: COMPLETE_EVENT_DISCRIMINATOR.length };
    const user = readPubkey(cursor);
    const mint = readPubkey(cursor);
    const bondingCurve = readPubkey(cursor);
    const timestamp = readI64LE(cursor);
    return { user, mint, bondingCurve, timestamp };
  } catch {
    return null;
  }
};

export const parsePumpfunActivityEvents = (
  event: ProgramLogEvent,
): readonly ParsedActivityEvent[] => {
  if (event.err !== null) return [];

  const found: ParsedActivityEvent[] = [];

  for (const line of event.logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const base64 = line.slice(PROGRAM_DATA_PREFIX.length);

    if (base64.startsWith(TRADE_EVENT_DISCRIMINATOR_BASE64_PREFIX)) {
      const bytes = Buffer.from(base64, 'base64');
      if (!matchesDiscriminator(bytes, TRADE_EVENT_DISCRIMINATOR)) continue;
      const trade = decodeTradeEvent(bytes);
      if (trade !== null) found.push({ kind: 'trade', data: trade });
      continue;
    }

    if (base64.startsWith(COMPLETE_EVENT_DISCRIMINATOR_BASE64_PREFIX)) {
      const bytes = Buffer.from(base64, 'base64');
      if (!matchesDiscriminator(bytes, COMPLETE_EVENT_DISCRIMINATOR)) continue;
      const complete = decodeCompleteEvent(bytes);
      if (complete !== null) found.push({ kind: 'complete', data: complete });
    }
  }

  return found;
};
