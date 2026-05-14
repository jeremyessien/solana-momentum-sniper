import { describe, expect, test } from 'vitest';
import type { DetectedToken } from '../shared/detectedToken.js';
import { err, ok } from '../shared/result.js';
import type { RugCheckSnapshot } from '../shared/rugCheckSnapshot.js';
import type { TokenTrackingClosed } from '../shared/tokenTrackingClosed.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';
import {
  formatNewTokenLaunchDetected,
  formatTokenAnalysisCompleted,
  formatTokenTrackingClosed,
} from './telegramMessages.js';

const sampleToken = (overrides: Partial<DetectedToken> = {}): DetectedToken => ({
  internalId: 'int-1',
  mint: 'J71oozcoh6BcYjk14V7vjb1EcHkLyY7WVELz3RLpump',
  launchpad: 'pumpfun',
  creatorWallet: '8oZiaf74SwU9YufXNWHHZj6kih6RrqaZ3T38exYD27jw',
  initialLiquidityLamports: 30_400_000_000n,
  detectedAt: new Date('2026-05-11T12:00:00Z'),
  ...overrides,
});

const sampleSnapshot = (overrides: Partial<RugCheckSnapshot> = {}): RugCheckSnapshot => ({
  snapshotAt: new Date('2026-05-11T12:00:00Z'),
  mint: 'J71oozcoh6BcYjk14V7vjb1EcHkLyY7WVELz3RLpump',
  score: 1,
  scoreNormalised: 1,
  risks: [],
  rugged: false,
  creatorBalance: 0n,
  mintAuthority: null,
  freezeAuthority: null,
  topHolders: [
    {
      address: 'h1',
      owner: 'o1',
      amount: 900_000_000_000_000n,
      pct: 90.06,
      insider: false,
    },
  ],
  totalHolders: 799,
  totalMarketLiquidityUsd: 57750,
  tokenName: 'DOGE',
  tokenSymbol: 'DOGE',
  rawJson: '{}',
  ...overrides,
});

describe('formatNewTokenLaunchDetected', () => {
  test('produces the expected lines for a typical detection', () => {
    const out = formatNewTokenLaunchDetected(sampleToken());
    expect(out).toContain('🆕 <b>New launch</b>');
    expect(out).toContain('<b>Mint:</b> <code>J71oozcoh6BcYjk14V7vjb1EcHkLyY7WVELz3RLpump</code>');
    expect(out).toContain('<b>Liquidity:</b> 30.40 SOL');
    expect(out).toContain('<b>Launchpad:</b> pumpfun');
  });
});

describe('formatTokenAnalysisCompleted', () => {
  test('formats a successful analysis with token name, symbol, and key fields', () => {
    const analysis: TokenWithFullContext = {
      detected: sampleToken(),
      analyzedAt: new Date('2026-05-11T12:00:00Z'),
      rugcheck: ok(sampleSnapshot()),
    };
    const out = formatTokenAnalysisCompleted(analysis);
    expect(out).toContain('📊 <b>Analysis: $DOGE (DOGE)</b>');
    expect(out).toContain('<b>Risk score:</b> 1/10');
    expect(out).toContain('<b>Holders:</b> 799 (top: 90.1%)');
    expect(out).toContain('<b>Mint authority:</b> renounced ✓');
    expect(out).toContain('<b>Freeze authority:</b> renounced ✓');
    expect(out).toContain('<b>Liquidity:</b> $57750');
  });

  test('flags rugged tokens', () => {
    const analysis: TokenWithFullContext = {
      detected: sampleToken(),
      analyzedAt: new Date(),
      rugcheck: ok(sampleSnapshot({ rugged: true })),
    };
    const out = formatTokenAnalysisCompleted(analysis);
    expect(out).toContain('RUGGED FLAG SET');
  });

  test('shows risk flags when present', () => {
    const analysis: TokenWithFullContext = {
      detected: sampleToken(),
      analyzedAt: new Date(),
      rugcheck: ok(
        sampleSnapshot({
          risks: [
            {
              name: 'Top 10 holders high ownership',
              level: 'danger',
              score: 9296,
              description: '',
            },
          ],
        }),
      ),
    };
    const out = formatTokenAnalysisCompleted(analysis);
    expect(out).toContain('<b>Flags:</b> Top 10 holders high ownership');
  });

  test('warns when mint or freeze authority is active', () => {
    const analysis: TokenWithFullContext = {
      detected: sampleToken(),
      analyzedAt: new Date(),
      rugcheck: ok(
        sampleSnapshot({
          mintAuthority: 'SomeMintAuthority',
          freezeAuthority: 'SomeFreezeAuthority',
        }),
      ),
    };
    const out = formatTokenAnalysisCompleted(analysis);
    expect(out).toContain('<b>Mint authority:</b> active ⚠️');
    expect(out).toContain('<b>Freeze authority:</b> active ⚠️');
  });

  test('formats a failed analysis with the reason and status code', () => {
    const analysis: TokenWithFullContext = {
      detected: sampleToken(),
      analyzedAt: new Date(),
      rugcheck: err({ kind: 'http_error', status: 503 }),
    };
    const out = formatTokenAnalysisCompleted(analysis);
    expect(out).toContain('📊 <b>Analysis failed</b>');
    expect(out).toContain('<b>Reason:</b> http_error (503)');
  });

  test('formats a timeout failure', () => {
    const analysis: TokenWithFullContext = {
      detected: sampleToken(),
      analyzedAt: new Date(),
      rugcheck: err({ kind: 'timeout' }),
    };
    const out = formatTokenAnalysisCompleted(analysis);
    expect(out).toContain('<b>Reason:</b> timeout');
    expect(out).not.toContain('(');
  });

  test('escapes HTML special characters in token names', () => {
    const analysis: TokenWithFullContext = {
      detected: sampleToken(),
      analyzedAt: new Date(),
      rugcheck: ok(sampleSnapshot({ tokenName: '<script>alert(1)</script>', tokenSymbol: 'A&B' })),
    };
    const out = formatTokenAnalysisCompleted(analysis);
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('A&amp;B');
    expect(out).not.toContain('<script>alert');
  });
});

describe('formatTokenTrackingClosed', () => {
  test('formats a graduated tracking close', () => {
    const event: TokenTrackingClosed = {
      tokenInternalId: 'int-1',
      mint: 'J71oozcoh6BcYjk14V7vjb1EcHkLyY7WVELz3RLpump',
      closedAt: new Date('2026-05-11T12:30:00Z'),
      reason: 'graduated',
      tradeCount: 47,
      buyCount: 32,
      sellCount: 15,
      uniqueTraders: 28,
      creatorTraded: true,
      firstTradeSlot: 100n,
      lastTradeSlot: 200n,
    };
    const out = formatTokenTrackingClosed(event);
    expect(out).toContain('🏁 <b>Tracking closed</b>');
    expect(out).toContain('<b>Reason:</b> graduated');
    expect(out).toContain('<b>Trades:</b> 47 (32 buys, 15 sells)');
    expect(out).toContain('<b>Unique traders:</b> 28');
    expect(out).toContain('<b>Creator traded:</b> yes');
  });

  test('formats a timeout tracking close', () => {
    const event: TokenTrackingClosed = {
      tokenInternalId: 'int-1',
      mint: 'M2',
      closedAt: new Date(),
      reason: 'timeout',
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      uniqueTraders: 0,
      creatorTraded: false,
      firstTradeSlot: null,
      lastTradeSlot: null,
    };
    const out = formatTokenTrackingClosed(event);
    expect(out).toContain('<b>Reason:</b> timeout');
    expect(out).toContain('<b>Trades:</b> 0 (0 buys, 0 sells)');
    expect(out).toContain('<b>Creator traded:</b> no');
  });
});
