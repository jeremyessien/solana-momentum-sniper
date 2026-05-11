import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { ProgramLogEvent } from '../shared/programLogEvent.js';
import { parsePumpfunActivityEvents } from './pumpfunTradeParser.js';

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

const loadFixture = (filename: string): ProgramLogEvent => {
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

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const buildSyntheticCompleteEventLog = (params: {
  userByte: number;
  mintByte: number;
  bondingCurveByte: number;
  timestamp: bigint;
}): string => {
  const discriminator = Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]);
  const user = Buffer.alloc(32, params.userByte);
  const mint = Buffer.alloc(32, params.mintByte);
  const bondingCurve = Buffer.alloc(32, params.bondingCurveByte);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigInt64LE(params.timestamp);
  const payload = Buffer.concat([discriminator, user, mint, bondingCurve, timestamp]);
  return `Program data: ${payload.toString('base64')}`;
};

describe('parsePumpfunActivityEvents', () => {
  test('parses a real Buy TradeEvent fixture into a trade with isBuy=true', () => {
    const event = loadFixture('pumpfun-trade-buy-sample.json');
    const events = parsePumpfunActivityEvents(event);

    const trades = events.filter((e) => e.kind === 'trade');
    expect(trades.length).toBeGreaterThanOrEqual(1);

    const first = trades[0];
    expect(first).toBeDefined();
    if (!first || first.kind !== 'trade') return;

    expect(first.data.isBuy).toBe(true);
    expect(first.data.mint).toMatch(BASE58_REGEX);
    expect(first.data.user).toMatch(BASE58_REGEX);
    expect(first.data.solAmount).toBeGreaterThan(0n);
    expect(first.data.tokenAmount).toBeGreaterThan(0n);
    expect(first.data.virtualSolReserves).toBeGreaterThan(0n);
    expect(first.data.virtualTokenReserves).toBeGreaterThan(0n);
    expect(typeof first.data.solAmount).toBe('bigint');
    expect(typeof first.data.tokenAmount).toBe('bigint');
    expect(typeof first.data.timestamp).toBe('bigint');
  });

  test('parses a real Sell TradeEvent fixture into a trade with isBuy=false', () => {
    const event = loadFixture('pumpfun-trade-sell-sample.json');
    const events = parsePumpfunActivityEvents(event);

    const trades = events.filter((e) => e.kind === 'trade');
    expect(trades.length).toBeGreaterThanOrEqual(1);

    const first = trades[0];
    expect(first).toBeDefined();
    if (!first || first.kind !== 'trade') return;

    expect(first.data.isBuy).toBe(false);
    expect(first.data.mint).toMatch(BASE58_REGEX);
    expect(first.data.user).toMatch(BASE58_REGEX);
  });

  test('parses a synthetic CompleteEvent payload with exact field values', () => {
    const event: ProgramLogEvent = {
      signature: 'synthetic-complete',
      slot: 100n,
      logs: [
        buildSyntheticCompleteEventLog({
          userByte: 0x11,
          mintByte: 0x22,
          bondingCurveByte: 0x33,
          timestamp: 1_700_000_000n,
        }),
      ],
      err: null,
    };

    const events = parsePumpfunActivityEvents(event);
    expect(events).toHaveLength(1);

    const first = events[0];
    expect(first?.kind).toBe('complete');
    if (first?.kind !== 'complete') return;

    expect(first.data.timestamp).toBe(1_700_000_000n);
    expect(first.data.user).toMatch(BASE58_REGEX);
    expect(first.data.mint).toMatch(BASE58_REGEX);
    expect(first.data.bondingCurve).toMatch(BASE58_REGEX);
    expect(first.data.user).not.toBe(first.data.mint);
    expect(first.data.mint).not.toBe(first.data.bondingCurve);
  });

  test('parses additional buy and sell fixture samples consistently', () => {
    const buyEvent = loadFixture('pumpfun-trade-buy-sample-2.json');
    const buyEvents = parsePumpfunActivityEvents(buyEvent);
    const buyTrades = buyEvents.filter((e) => e.kind === 'trade');
    expect(buyTrades.length).toBeGreaterThanOrEqual(1);
    if (buyTrades[0]?.kind === 'trade') {
      expect(buyTrades[0].data.isBuy).toBe(true);
      expect(buyTrades[0].data.mint).toMatch(BASE58_REGEX);
    }

    const sellEvent = loadFixture('pumpfun-trade-sell-sample-2.json');
    const sellEvents = parsePumpfunActivityEvents(sellEvent);
    const sellTrades = sellEvents.filter((e) => e.kind === 'trade');
    expect(sellTrades.length).toBeGreaterThanOrEqual(1);
    if (sellTrades[0]?.kind === 'trade') {
      expect(sellTrades[0].data.isBuy).toBe(false);
    }
  });

  test('returns an empty array when err is non-null', () => {
    const event = loadFixture('pumpfun-trade-buy-sample.json');
    const errored: ProgramLogEvent = { ...event, err: { InstructionError: [0, 'Custom'] } };
    expect(parsePumpfunActivityEvents(errored)).toEqual([]);
  });

  test('returns an empty array when logs have no Program data lines', () => {
    const event: ProgramLogEvent = {
      signature: 'sig',
      slot: 1n,
      logs: ['Program log: hello', 'Program log: world'],
      err: null,
    };
    expect(parsePumpfunActivityEvents(event)).toEqual([]);
  });

  test('returns an empty array when Program data lines have unknown discriminators', () => {
    const event: ProgramLogEvent = {
      signature: 'sig',
      slot: 1n,
      logs: ['Program data: AAAA0000000000000000'],
      err: null,
    };
    expect(parsePumpfunActivityEvents(event)).toEqual([]);
  });

  test('skips a Program data line whose base64 prefix matches but full discriminator does not', () => {
    const event: ProgramLogEvent = {
      signature: 'sig',
      slot: 1n,
      logs: [`Program data: vdt/00${Buffer.alloc(120).toString('base64').slice(0, 100)}`],
      err: null,
    };
    expect(parsePumpfunActivityEvents(event)).toEqual([]);
  });
});
