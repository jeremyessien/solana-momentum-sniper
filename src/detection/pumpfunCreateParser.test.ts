import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { ProgramLogEvent } from '../shared/programLogEvent.js';
import { parsePumpfunCreate } from './pumpfunCreateParser.js';

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

const fixtureEvent = loadFixture('pumpfun-create-v2-sample.json');

const options = {
  internalId: 'test-id-fixed',
  detectedAt: new Date('2026-05-09T00:00:00Z'),
};

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ONE_SOL_LAMPORTS = 1_000_000_000n;
const ONE_THOUSAND_SOL_LAMPORTS = 1_000_000_000_000n;

const ADDITIONAL_FIXTURES = ['pumpfun-create-v2-sample-2.json', 'pumpfun-create-v2-sample-3.json'];

describe('parsePumpfunCreate', () => {
  test('returns a DetectedToken with verified field values for a real CreateV2', () => {
    const result = parsePumpfunCreate(fixtureEvent, options);

    expect(result).not.toBeNull();
    if (result === null) return;

    expect(result.mint).toBe('EE4WA7PfPPPRexiFGyi2w8e2yuxqyhy6JZvLncyepump');
    expect(result.creatorWallet).toBe('89gYehpQsfarYsM8rGqbCd1PtmbqMNKy8xKUWFjY3V1S');
    expect(result.initialLiquidityLamports).toBe(30_000_000_000n);
    expect(result.launchpad).toBe('pumpfun');
    expect(result.internalId).toBe(options.internalId);
    expect(result.detectedAt).toBe(options.detectedAt);
  });

  test('returns null when event.err is non-null', () => {
    const failedEvent: ProgramLogEvent = {
      ...fixtureEvent,
      err: { InstructionError: [0, 'Custom'] },
    };
    expect(parsePumpfunCreate(failedEvent, options)).toBeNull();
  });

  test('returns null when no Create instruction log is present', () => {
    const noCreateEvent: ProgramLogEvent = {
      ...fixtureEvent,
      logs: [
        'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
        'Program log: Instruction: Buy',
        'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
      ],
    };
    expect(parsePumpfunCreate(noCreateEvent, options)).toBeNull();
  });

  test('returns null when Create marker is present but no matching data line', () => {
    const noDataEvent: ProgramLogEvent = {
      ...fixtureEvent,
      logs: [
        'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
        'Program log: Instruction: CreateV2',
        'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
      ],
    };
    expect(parsePumpfunCreate(noDataEvent, options)).toBeNull();
  });

  test('returns null when Program data line has a different discriminator', () => {
    const wrongDataEvent: ProgramLogEvent = {
      ...fixtureEvent,
      logs: [
        'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
        'Program log: Instruction: CreateV2',
        'Program data: vdt/007mYe7EgHDq9vjM4f',
        'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
      ],
    };
    expect(parsePumpfunCreate(wrongDataEvent, options)).toBeNull();
  });

  test('returns null when payload matches discriminator but is truncated', () => {
    const truncatedEvent: ProgramLogEvent = {
      ...fixtureEvent,
      logs: [
        'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
        'Program log: Instruction: CreateV2',
        'Program data: G3KpTd7rY3Y=',
        'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
      ],
    };
    expect(parsePumpfunCreate(truncatedEvent, options)).toBeNull();
  });

  test.each(
    ADDITIONAL_FIXTURES,
  )('parses %s with structurally valid fields and a sensible lamport range', (filename) => {
    const event = loadFixture(filename);
    const result = parsePumpfunCreate(event, options);

    expect(result).not.toBeNull();
    if (result === null) return;

    expect(result.mint).toMatch(BASE58_REGEX);
    expect(result.creatorWallet).toMatch(BASE58_REGEX);
    expect(result.launchpad).toBe('pumpfun');
    expect(result.initialLiquidityLamports).toBeGreaterThan(ONE_SOL_LAMPORTS);
    expect(result.initialLiquidityLamports).toBeLessThan(ONE_THOUSAND_SOL_LAMPORTS);
  });
});
