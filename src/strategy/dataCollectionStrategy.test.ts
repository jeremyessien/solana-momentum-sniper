import { describe, expect, it } from 'vitest';
import type { DetectedToken } from '../shared/detectedToken.js';
import { err, ok } from '../shared/result.js';
import type { RugCheckSnapshot } from '../shared/rugCheckSnapshot.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';
import {
  DATA_COLLECTION_THRESHOLDS,
  evaluateDataCollectionStrategy,
} from './dataCollectionStrategy.js';

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

const candidate = (overrides: Partial<RugCheckSnapshot> = {}): TokenWithFullContext => ({
  detected: baseDetected,
  analyzedAt: new Date('2026-05-20T12:00:02Z'),
  rugcheck: ok({ ...baseSnapshot, ...overrides }),
});

const erredCandidate: TokenWithFullContext = {
  detected: baseDetected,
  analyzedAt: new Date('2026-05-20T12:00:02Z'),
  rugcheck: err({ kind: 'http_error', status: 400 }),
};

describe('evaluateDataCollectionStrategy', () => {
  const t = DATA_COLLECTION_THRESHOLDS;

  it('passes with rugcheck_failed when rugcheck is an err result', () => {
    const result = evaluateDataCollectionStrategy(erredCandidate, t);
    expect(result).toEqual({ kind: 'pass', reasons: ['rugcheck_failed'] });
  });

  it('passes a rugged token', () => {
    const result = evaluateDataCollectionStrategy(candidate({ rugged: true }), t);
    expect(result).toEqual({ kind: 'pass', reasons: ['rugged'] });
  });

  it('passes a token with an active mint authority', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({ mintAuthority: 'creator-wallet' }),
      t,
    );
    expect(result).toEqual({ kind: 'pass', reasons: ['mint_authority_active'] });
  });

  it('passes a token with an active freeze authority', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({ freezeAuthority: 'creator-wallet' }),
      t,
    );
    expect(result).toEqual({ kind: 'pass', reasons: ['freeze_authority_active'] });
  });

  it('passes when the largest holder exceeds the watch threshold', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({
        topHolders: [{ address: 'h1', owner: 'h1', amount: 0n, pct: 35, insider: false }],
      }),
      t,
    );
    expect(result).toEqual({ kind: 'pass', reasons: ['top_holder_excessive'] });
  });

  it('passes when scoreNormalised exceeds the watch threshold', () => {
    const result = evaluateDataCollectionStrategy(candidate({ scoreNormalised: 70 }), t);
    expect(result).toEqual({ kind: 'pass', reasons: ['score_too_risky'] });
  });

  it('collects every hard-failure reason in deterministic order', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({
        rugged: true,
        mintAuthority: 'm',
        freezeAuthority: 'f',
        scoreNormalised: 90,
        topHolders: [{ address: 'h1', owner: 'h1', amount: 0n, pct: 80, insider: false }],
      }),
      t,
    );
    expect(result).toEqual({
      kind: 'pass',
      reasons: [
        'rugged',
        'mint_authority_active',
        'freeze_authority_active',
        'top_holder_excessive',
        'score_too_risky',
      ],
    });
  });

  it('enters a clean token with score and holder both below the Enter cutoffs', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({
        scoreNormalised: 25,
        topHolders: [{ address: 'h1', owner: 'h1', amount: 0n, pct: 15, insider: false }],
      }),
      t,
    );
    expect(result).toEqual({ kind: 'enter' });
  });

  it('enters at exactly the Enter boundaries (inclusive)', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({
        scoreNormalised: 30,
        topHolders: [{ address: 'h1', owner: 'h1', amount: 0n, pct: 20, insider: false }],
      }),
      t,
    );
    expect(result).toEqual({ kind: 'enter' });
  });

  it('watches with score_borderline only when score is in Watch range and holder is clean', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({
        scoreNormalised: 50,
        topHolders: [{ address: 'h1', owner: 'h1', amount: 0n, pct: 15, insider: false }],
      }),
      t,
    );
    expect(result).toEqual({ kind: 'watch', reasons: ['score_borderline'] });
  });

  it('watches with holder_concentration_borderline only when holder is in Watch range and score is clean', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({
        scoreNormalised: 25,
        topHolders: [{ address: 'h1', owner: 'h1', amount: 0n, pct: 25, insider: false }],
      }),
      t,
    );
    expect(result).toEqual({ kind: 'watch', reasons: ['holder_concentration_borderline'] });
  });

  it('watches with both borderline reasons when both are in Watch range', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({
        scoreNormalised: 50,
        topHolders: [{ address: 'h1', owner: 'h1', amount: 0n, pct: 25, insider: false }],
      }),
      t,
    );
    expect(result).toEqual({
      kind: 'watch',
      reasons: ['score_borderline', 'holder_concentration_borderline'],
    });
  });

  it('watches at exactly the Watch boundaries (inclusive)', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({
        scoreNormalised: 60,
        topHolders: [{ address: 'h1', owner: 'h1', amount: 0n, pct: 30, insider: false }],
      }),
      t,
    );
    expect(result).toEqual({
      kind: 'watch',
      reasons: ['score_borderline', 'holder_concentration_borderline'],
    });
  });

  it('treats an empty topHolders array as 0% concentration', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({ scoreNormalised: 25, topHolders: [] }),
      t,
    );
    expect(result).toEqual({ kind: 'enter' });
  });

  it('uses the largest holder pct when multiple holders are present', () => {
    const result = evaluateDataCollectionStrategy(
      candidate({
        scoreNormalised: 25,
        topHolders: [
          { address: 'h1', owner: 'h1', amount: 0n, pct: 5, insider: false },
          { address: 'h2', owner: 'h2', amount: 0n, pct: 35, insider: false },
          { address: 'h3', owner: 'h3', amount: 0n, pct: 2, insider: false },
        ],
      }),
      t,
    );
    expect(result).toEqual({ kind: 'pass', reasons: ['top_holder_excessive'] });
  });
});
