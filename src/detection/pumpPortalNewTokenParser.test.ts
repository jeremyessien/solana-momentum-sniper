import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parsePumpPortalNewToken } from './pumpPortalNewTokenParser.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures',
);

const samples = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, 'pumpportal-newtoken-samples.json'), 'utf-8'),
) as readonly unknown[];

const frame = (index: number): string => JSON.stringify(samples[index]);

const options = {
  internalId: 'test-id-fixed',
  detectedAt: new Date('2026-07-31T00:00:00Z'),
};

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CONFIRMATION = 0;
const PUMP_CREATES = [1, 2, 3, 4];
const BONK_CREATE = 5;

describe('parsePumpPortalNewToken', () => {
  test('maps a real Pump.fun create with verified field values', () => {
    const result = parsePumpPortalNewToken(frame(1), options);

    expect(result).not.toBeNull();
    if (result === null) return;

    expect(result.mint).toBe('3dNTei6DqmoA97JkFqkTtbKDbLFwvpwUFJY8U9X4pump');
    expect(result.creatorWallet).toBe('3VF7CW2JqRU79yq3WCHdGY67BA6x3UtBxzrTPE1cdTqk');
    expect(result.initialLiquidityLamports).toBe(30_000_000_000n);
    expect(result.launchpad).toBe('pumpfun');
    expect(result.internalId).toBe(options.internalId);
    expect(result.detectedAt).toBe(options.detectedAt);
  });

  test.each(
    PUMP_CREATES,
  )('parses pump create at index %i with valid fields and a sensible lamport range', (index) => {
    const result = parsePumpPortalNewToken(frame(index), options);

    expect(result).not.toBeNull();
    if (result === null) return;

    expect(result.mint).toMatch(BASE58_REGEX);
    expect(result.creatorWallet).toMatch(BASE58_REGEX);
    expect(result.launchpad).toBe('pumpfun');
    expect(result.initialLiquidityLamports).toBeGreaterThanOrEqual(30_000_000_000n);
    expect(result.initialLiquidityLamports).toBeLessThan(31_000_000_000n);
  });

  test('returns null for a non-Pump.fun (bonk) launch', () => {
    expect(parsePumpPortalNewToken(frame(BONK_CREATE), options)).toBeNull();
  });

  test('returns null for the subscription confirmation frame', () => {
    expect(parsePumpPortalNewToken(frame(CONFIRMATION), options)).toBeNull();
  });

  test('returns null for a malformed JSON frame', () => {
    expect(parsePumpPortalNewToken('{ not json', options)).toBeNull();
  });

  test('returns null when a required field is missing', () => {
    const withoutMint = JSON.stringify({
      txType: 'create',
      pool: 'pump',
      traderPublicKey: 'BqJLQYYwhL6EJkuq39zB8FWSaHeQr94x4X1CY6c1DqGT',
      vSolInBondingCurve: 30,
    });
    expect(parsePumpPortalNewToken(withoutMint, options)).toBeNull();
  });

  test('returns null when vSolInBondingCurve exceeds safe-integer range once scaled', () => {
    const huge = JSON.stringify({
      txType: 'create',
      pool: 'pump',
      mint: '3dNTei6DqmoA97JkFqkTtbKDbLFwvpwUFJY8U9X4pump',
      traderPublicKey: '3VF7CW2JqRU79yq3WCHdGY67BA6x3UtBxzrTPE1cdTqk',
      vSolInBondingCurve: 1e30,
    });
    expect(parsePumpPortalNewToken(huge, options)).toBeNull();
  });

  test('returns null when vSolInBondingCurve is negative', () => {
    const negative = JSON.stringify({
      txType: 'create',
      pool: 'pump',
      mint: '3dNTei6DqmoA97JkFqkTtbKDbLFwvpwUFJY8U9X4pump',
      traderPublicKey: '3VF7CW2JqRU79yq3WCHdGY67BA6x3UtBxzrTPE1cdTqk',
      vSolInBondingCurve: -5,
    });
    expect(parsePumpPortalNewToken(negative, options)).toBeNull();
  });
});
