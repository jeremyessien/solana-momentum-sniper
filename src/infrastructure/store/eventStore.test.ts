import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { DetectedToken } from '../../shared/detectedToken.js';
import { ok } from '../../shared/result.js';
import type { RugCheckSnapshot } from '../../shared/rugCheckSnapshot.js';
import type { StrategyEvaluationResult } from '../../shared/strategyEvaluationResult.js';
import type { TokenTrackingClosed } from '../../shared/tokenTrackingClosed.js';
import type { TokenTradeObserved } from '../../shared/tokenTradeObserved.js';
import type { TokenWithFullContext } from '../../shared/tokenWithFullContext.js';
import { createSqliteEventStore, type EventStore } from './eventStore.js';

const silentLogger = pino({ level: 'silent' });

const buildDetection = (overrides: Partial<DetectedToken> = {}): DetectedToken => ({
  internalId: 'token-1',
  mint: 'MintAddress1',
  launchpad: 'pumpfun',
  creatorWallet: 'CreatorWallet1',
  initialLiquidityLamports: 5_000_000_000n,
  detectedAt: new Date('2026-05-15T10:00:00.000Z'),
  ...overrides,
});

const buildRugcheckSnapshot = (): RugCheckSnapshot => ({
  snapshotAt: new Date('2026-05-15T10:00:01.000Z'),
  mint: 'MintAddress1',
  score: 80,
  scoreNormalised: 80,
  risks: [],
  rugged: false,
  creatorBalance: 0n,
  mintAuthority: null,
  freezeAuthority: null,
  topHolders: [],
  totalHolders: 50,
  totalMarketLiquidityUsd: 12500,
  tokenName: 'Test',
  tokenSymbol: 'TST',
  rawJson: '{}',
});

const buildAnalysis = (overrides: Partial<TokenWithFullContext> = {}): TokenWithFullContext => ({
  detected: buildDetection(),
  analyzedAt: new Date('2026-05-15T10:00:01.000Z'),
  rugcheck: ok(buildRugcheckSnapshot()),
  ...overrides,
});

const buildTrade = (overrides: Partial<TokenTradeObserved> = {}): TokenTradeObserved => ({
  tokenInternalId: 'token-1',
  mint: 'MintAddress1',
  trader: 'TraderWallet1',
  isBuy: true,
  solAmount: 1_000_000_000n,
  tokenAmount: 1_000_000n,
  virtualSolReserves: 30_000_000_000n,
  virtualTokenReserves: 1_000_000_000_000n,
  slot: 250_000_000n,
  signature: 'sig-1',
  observedAt: new Date('2026-05-15T10:00:05.000Z'),
  pumpFunTimestamp: 1_747_303_205n,
  ...overrides,
});

const buildTrackingClosed = (
  overrides: Partial<TokenTrackingClosed> = {},
): TokenTrackingClosed => ({
  tokenInternalId: 'token-1',
  mint: 'MintAddress1',
  closedAt: new Date('2026-05-15T10:30:00.000Z'),
  reason: 'graduated',
  tradeCount: 42,
  buyCount: 25,
  sellCount: 17,
  uniqueTraders: 20,
  creatorTraded: false,
  firstTradeSlot: 250_000_000n,
  lastTradeSlot: 250_000_500n,
  ...overrides,
});

describe('createSqliteEventStore', () => {
  let dir: string;
  let dbPath: string;
  let store: EventStore;
  let reader: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-store-test-'));
    dbPath = join(dir, 'store.db');
    store = createSqliteEventStore({ path: dbPath, logger: silentLogger });
    reader = new Database(dbPath, { readonly: true });
    reader.defaultSafeIntegers(true);
  });

  afterEach(() => {
    reader.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('applies migrations on construction', () => {
    const tables = reader
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      'lifecycle_events',
      'tracked_tokens',
      'trade_events',
    ]);
  });

  test('recordDetection writes lifecycle row and tracked_tokens row', () => {
    const detection = buildDetection();
    store.recordDetection(detection);

    const lifecycle = reader
      .prepare(
        "SELECT event_type, token_internal_id, occurred_at_ms FROM lifecycle_events WHERE event_type = 'newTokenLaunchDetected'",
      )
      .all() as { event_type: string; token_internal_id: string; occurred_at_ms: bigint }[];
    expect(lifecycle).toHaveLength(1);
    const first = lifecycle[0];
    expect(first?.token_internal_id).toBe('token-1');
    expect(first?.occurred_at_ms).toBe(BigInt(detection.detectedAt.getTime()));

    const tracked = reader
      .prepare('SELECT * FROM tracked_tokens WHERE token_internal_id = ?')
      .get('token-1') as {
      mint: string;
      enrichment_status: string;
      tracking_status: string;
      closed_at_ms: bigint | null;
    };
    expect(tracked.mint).toBe('MintAddress1');
    expect(tracked.enrichment_status).toBe('pending');
    expect(tracked.tracking_status).toBe('active');
    expect(tracked.closed_at_ms).toBeNull();
  });

  test('recordAnalysisCompleted updates enrichment_status', () => {
    store.recordDetection(buildDetection());
    store.recordAnalysisCompleted(buildAnalysis());

    const tracked = reader
      .prepare('SELECT enrichment_status FROM tracked_tokens WHERE token_internal_id = ?')
      .get('token-1') as { enrichment_status: string };
    expect(tracked.enrichment_status).toBe('completed');

    const lifecycle = reader
      .prepare(
        "SELECT COUNT(*) AS n FROM lifecycle_events WHERE event_type = 'tokenAnalysisCompleted'",
      )
      .get() as { n: bigint };
    expect(lifecycle.n).toBe(1n);
  });

  test('recordTrackingClosed updates tracking_status and closed_at_ms', () => {
    store.recordDetection(buildDetection());
    const closed = buildTrackingClosed();
    store.recordTrackingClosed(closed);

    const tracked = reader
      .prepare(
        'SELECT tracking_status, closed_at_ms FROM tracked_tokens WHERE token_internal_id = ?',
      )
      .get('token-1') as { tracking_status: string; closed_at_ms: bigint };
    expect(tracked.tracking_status).toBe('graduated');
    expect(tracked.closed_at_ms).toBe(BigInt(closed.closedAt.getTime()));
  });

  test('recordTradeObserved writes a trade row', () => {
    store.recordDetection(buildDetection());
    store.recordTradeObserved(buildTrade());

    const trades = reader
      .prepare('SELECT * FROM trade_events WHERE token_internal_id = ?')
      .all('token-1') as { side: string; signature: string }[];
    expect(trades).toHaveLength(1);
    expect(trades[0]?.side).toBe('buy');
    expect(trades[0]?.signature).toBe('sig-1');
  });

  test('recordTradeObserved is idempotent on (token_internal_id, signature)', () => {
    store.recordDetection(buildDetection());
    const trade = buildTrade();
    store.recordTradeObserved(trade);
    store.recordTradeObserved(trade);
    store.recordTradeObserved(trade);

    const count = reader
      .prepare('SELECT COUNT(*) AS n FROM trade_events WHERE token_internal_id = ?')
      .get('token-1') as { n: bigint };
    expect(count.n).toBe(1n);
  });

  test('bigint values above 2^53 round-trip through INTEGER columns', () => {
    const hugeSlot = 2n ** 60n;
    store.recordDetection(buildDetection());
    store.recordTradeObserved(buildTrade({ slot: hugeSlot, signature: 'sig-huge' }));

    const trade = reader
      .prepare('SELECT slot FROM trade_events WHERE signature = ?')
      .get('sig-huge') as { slot: bigint };
    expect(trade.slot).toBe(hugeSlot);
  });

  test('bigint values in payload JSON are stringified, not lost', () => {
    const detection = buildDetection({ initialLiquidityLamports: 2n ** 60n });
    store.recordDetection(detection);

    const row = reader
      .prepare("SELECT payload FROM lifecycle_events WHERE event_type = 'newTokenLaunchDetected'")
      .get() as { payload: string };
    const parsed = JSON.parse(row.payload) as { initialLiquidityLamports: string };
    expect(parsed.initialLiquidityLamports).toBe((2n ** 60n).toString());
  });

  test('out-of-order arrival: tracking_closed before detection still records lifecycle row', () => {
    store.recordTrackingClosed(buildTrackingClosed());

    const lifecycle = reader
      .prepare(
        "SELECT COUNT(*) AS n FROM lifecycle_events WHERE event_type = 'tokenTrackingClosed'",
      )
      .get() as { n: bigint };
    expect(lifecycle.n).toBe(1n);

    const tracked = reader
      .prepare('SELECT * FROM tracked_tokens WHERE token_internal_id = ?')
      .get('token-1');
    expect(tracked).toBeUndefined();
  });

  test('analysis with failed rugcheck records enrichment_status=failed', () => {
    store.recordDetection(buildDetection());
    const failedAnalysis: TokenWithFullContext = {
      detected: buildDetection(),
      analyzedAt: new Date('2026-05-15T10:00:01.000Z'),
      rugcheck: { kind: 'err', error: { kind: 'network', message: 'timeout' } as never },
    };
    store.recordAnalysisCompleted(failedAnalysis);

    const tracked = reader
      .prepare('SELECT enrichment_status FROM tracked_tokens WHERE token_internal_id = ?')
      .get('token-1') as { enrichment_status: string };
    expect(tracked.enrichment_status).toBe('failed');
  });

  test('pruneTradesOlderThan deletes only rows older than the cutoff', () => {
    store.recordDetection(buildDetection());
    store.recordTradeObserved(
      buildTrade({ signature: 'old-1', observedAt: new Date('2026-01-01T00:00:00.000Z') }),
    );
    store.recordTradeObserved(
      buildTrade({ signature: 'old-2', observedAt: new Date('2026-02-01T00:00:00.000Z') }),
    );
    store.recordTradeObserved(
      buildTrade({ signature: 'new-1', observedAt: new Date('2026-05-15T00:00:00.000Z') }),
    );

    const cutoff = BigInt(new Date('2026-04-01T00:00:00.000Z').getTime());
    const result = store.pruneTradesOlderThan(cutoff);

    expect(result.rowsDeleted).toBe(2);
    const remaining = reader
      .prepare('SELECT signature FROM trade_events ORDER BY signature')
      .all() as { signature: string }[];
    expect(remaining.map((r) => r.signature)).toEqual(['new-1']);
  });

  test('pruneTradesOlderThan chunks deletes when more rows than chunk size', () => {
    store.recordDetection(buildDetection());
    for (let i = 0; i < 25; i += 1) {
      store.recordTradeObserved(
        buildTrade({ signature: `sig-${i}`, observedAt: new Date('2026-01-01T00:00:00.000Z') }),
      );
    }

    const cutoff = BigInt(new Date('2026-04-01T00:00:00.000Z').getTime());
    const result = store.pruneTradesOlderThan(cutoff, 10);

    expect(result.rowsDeleted).toBe(25);
    const remaining = reader.prepare('SELECT COUNT(*) AS n FROM trade_events').get() as {
      n: bigint;
    };
    expect(remaining.n).toBe(0n);
  });

  test('side is rejected by CHECK constraint when not buy/sell', () => {
    store.recordDetection(buildDetection());
    const writer = new Database(dbPath);
    try {
      expect(() => {
        writer
          .prepare(
            "INSERT INTO trade_events (occurred_at_ms, token_internal_id, mint, trader_wallet, side, sol_amount_lamports, token_amount, slot, signature, payload) VALUES (1, 'x', 'm', 'w', 'hold', 1, 1, 1, 's', '{}')",
          )
          .run();
      }).toThrow(/CHECK constraint failed/);
    } finally {
      writer.close();
    }
  });

  test('pruneTradesOlderThan returns 0 when no rows match the cutoff', () => {
    store.recordDetection(buildDetection());
    store.recordTradeObserved(
      buildTrade({ observedAt: new Date('2026-05-15T00:00:00.000Z'), signature: 'recent' }),
    );
    const cutoff = BigInt(new Date('2020-01-01T00:00:00.000Z').getTime());

    const result = store.pruneTradesOlderThan(cutoff);

    expect(result.rowsDeleted).toBe(0);
    const remaining = reader.prepare('SELECT COUNT(*) AS n FROM trade_events').get() as {
      n: bigint;
    };
    expect(remaining.n).toBe(1n);
  });

  test('pruneTradesOlderThan rejects non-positive chunkSize', () => {
    expect(() => store.pruneTradesOlderThan(0n, 0)).toThrow(/chunkSize must be >= 1/);
    expect(() => store.pruneTradesOlderThan(0n, -10)).toThrow(/chunkSize must be >= 1/);
  });

  test('recordStrategyDecision writes lifecycle row and bumps last_event_seq', () => {
    const detection = buildDetection();
    store.recordDetection(detection);

    const decision: StrategyEvaluationResult = {
      strategyId: 'data-collection',
      candidate: buildAnalysis(),
      thresholds: {
        enterMaxScoreNormalised: 30,
        enterMaxTopHolderPercent: 20,
        watchMaxScoreNormalised: 60,
        watchMaxTopHolderPercent: 30,
      },
      decision: { kind: 'pass', reasons: ['score_too_risky'] },
      evaluatedAt: new Date('2026-05-15T10:00:02.000Z'),
    };
    store.recordStrategyDecision(decision);

    const row = reader
      .prepare(
        "SELECT event_type, token_internal_id, payload FROM lifecycle_events WHERE event_type = 'strategyDecisionRecorded'",
      )
      .get() as { event_type: string; token_internal_id: string; payload: string };

    expect(row.event_type).toBe('strategyDecisionRecorded');
    expect(row.token_internal_id).toBe(detection.internalId);

    const payload = JSON.parse(row.payload);
    expect(payload.strategyId).toBe('data-collection');
    expect(payload.decision).toEqual({ kind: 'pass', reasons: ['score_too_risky'] });
    expect(payload.thresholds).toEqual(decision.thresholds);

    const tracked = reader
      .prepare('SELECT last_event_seq FROM tracked_tokens WHERE token_internal_id = ?')
      .get(detection.internalId) as { last_event_seq: bigint };
    expect(tracked.last_event_seq).toBeGreaterThan(0n);
  });
});
