import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { DetectedToken } from '../../shared/detectedToken.js';
import type { StrategyEvaluationResult } from '../../shared/strategyEvaluationResult.js';
import type { TokenTrackingClosed } from '../../shared/tokenTrackingClosed.js';
import type { TokenTradeObserved } from '../../shared/tokenTradeObserved.js';
import type { TokenWithFullContext } from '../../shared/tokenWithFullContext.js';
import type { Logger } from '../logger/logger.js';
import { applyMigrations } from './migrate.js';

export type PruneResult = {
  readonly rowsDeleted: number;
};

export type EventStore = {
  readonly recordDetection: (event: DetectedToken) => void;
  readonly recordAnalysisCompleted: (event: TokenWithFullContext) => void;
  readonly recordTradeObserved: (event: TokenTradeObserved) => void;
  readonly recordTrackingClosed: (event: TokenTrackingClosed) => void;
  readonly recordStrategyDecision: (event: StrategyEvaluationResult) => void;
  readonly pruneTradesOlderThan: (cutoffMs: bigint, chunkSize?: number) => PruneResult;
  readonly close: () => void;
};

export type CreateSqliteEventStoreDeps = {
  readonly path: string;
  readonly logger: Logger;
};

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const stringifyPayload = (value: unknown): string =>
  JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? val.toString() : val));

const eventTypeOf = {
  detection: 'newTokenLaunchDetected',
  analysis: 'tokenAnalysisCompleted',
  trackingClosed: 'tokenTrackingClosed',
  strategyDecision: 'strategyDecisionRecorded',
} as const;

const enrichmentStatusOf = (analysis: TokenWithFullContext): 'completed' | 'failed' =>
  analysis.rugcheck.kind === 'ok' ? 'completed' : 'failed';

export const createSqliteEventStore = (deps: CreateSqliteEventStoreDeps): EventStore => {
  const db = new Database(deps.path);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -20000');
  db.pragma('auto_vacuum = INCREMENTAL');
  db.defaultSafeIntegers(true);

  applyMigrations({ db, migrationsDir: MIGRATIONS_DIR, logger: deps.logger });

  const insertLifecycle = db.prepare(`
    INSERT INTO lifecycle_events
      (occurred_at_ms, event_type, token_internal_id, payload)
    VALUES (?, ?, ?, ?)
  `);

  const upsertTrackedTokenOnDetection = db.prepare(`
    INSERT INTO tracked_tokens
      (token_internal_id, mint, launchpad, creator_wallet, detected_at_ms,
       enrichment_status, tracking_status, closed_at_ms, last_event_seq)
    VALUES (?, ?, ?, ?, ?, 'pending', 'active', NULL, ?)
    ON CONFLICT(token_internal_id) DO UPDATE SET
      last_event_seq = excluded.last_event_seq
  `);

  const updateTrackedTokenOnAnalysis = db.prepare(`
    UPDATE tracked_tokens
       SET enrichment_status = ?, last_event_seq = ?
     WHERE token_internal_id = ?
  `);

  const updateTrackedTokenOnTrackingClosed = db.prepare(`
    UPDATE tracked_tokens
       SET tracking_status = ?, closed_at_ms = ?, last_event_seq = ?
     WHERE token_internal_id = ?
  `);

  const updateTrackedTokenLastEventSeq = db.prepare(`
    UPDATE tracked_tokens
       SET last_event_seq = ?
     WHERE token_internal_id = ?
  `);

  const insertTrade = db.prepare(`
    INSERT OR IGNORE INTO trade_events
      (occurred_at_ms, token_internal_id, mint, trader_wallet, side,
       sol_amount_lamports, token_amount, slot, signature, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const recordDetection = db.transaction((event: DetectedToken): void => {
    const occurredAtMs = BigInt(event.detectedAt.getTime());
    const info = insertLifecycle.run(
      occurredAtMs,
      eventTypeOf.detection,
      event.internalId,
      stringifyPayload(event),
    );
    const seq = BigInt(info.lastInsertRowid);
    upsertTrackedTokenOnDetection.run(
      event.internalId,
      event.mint,
      event.launchpad,
      event.creatorWallet,
      occurredAtMs,
      seq,
    );
  });

  const recordAnalysisCompleted = db.transaction((event: TokenWithFullContext): void => {
    const occurredAtMs = BigInt(event.analyzedAt.getTime());
    const info = insertLifecycle.run(
      occurredAtMs,
      eventTypeOf.analysis,
      event.detected.internalId,
      stringifyPayload(event),
    );
    const seq = BigInt(info.lastInsertRowid);
    updateTrackedTokenOnAnalysis.run(enrichmentStatusOf(event), seq, event.detected.internalId);
  });

  const recordTrackingClosed = db.transaction((event: TokenTrackingClosed): void => {
    const occurredAtMs = BigInt(event.closedAt.getTime());
    const info = insertLifecycle.run(
      occurredAtMs,
      eventTypeOf.trackingClosed,
      event.tokenInternalId,
      stringifyPayload(event),
    );
    const seq = BigInt(info.lastInsertRowid);
    updateTrackedTokenOnTrackingClosed.run(event.reason, occurredAtMs, seq, event.tokenInternalId);
  });

  const recordStrategyDecision = db.transaction((event: StrategyEvaluationResult): void => {
    const tokenInternalId = event.candidate.detected.internalId;
    const occurredAtMs = BigInt(event.evaluatedAt.getTime());
    const info = insertLifecycle.run(
      occurredAtMs,
      eventTypeOf.strategyDecision,
      tokenInternalId,
      stringifyPayload(event),
    );
    const seq = BigInt(info.lastInsertRowid);
    updateTrackedTokenLastEventSeq.run(seq, tokenInternalId);
  });

  const recordTradeObserved = (event: TokenTradeObserved): void => {
    insertTrade.run(
      BigInt(event.observedAt.getTime()),
      event.tokenInternalId,
      event.mint,
      event.trader,
      event.isBuy ? 'buy' : 'sell',
      event.solAmount,
      event.tokenAmount,
      event.slot,
      event.signature,
      stringifyPayload(event),
    );
  };

  const deleteTradesOlderThan = db.prepare(`
    DELETE FROM trade_events
     WHERE rowid IN (
       SELECT rowid FROM trade_events WHERE occurred_at_ms < ? LIMIT ?
     )
  `);

  const pruneTradesOlderThan = (cutoffMs: bigint, chunkSize = 10_000): PruneResult => {
    if (chunkSize < 1) {
      throw new Error(`pruneTradesOlderThan: chunkSize must be >= 1, got ${chunkSize}`);
    }
    let totalDeleted = 0;
    while (true) {
      const info = deleteTradesOlderThan.run(cutoffMs, chunkSize);
      const deleted = Number(info.changes);
      totalDeleted += deleted;
      if (deleted < chunkSize) break;
    }
    db.pragma('incremental_vacuum(1000)');
    return { rowsDeleted: totalDeleted };
  };

  const close = (): void => {
    db.close();
  };

  return {
    recordDetection,
    recordAnalysisCompleted,
    recordTradeObserved,
    recordTrackingClosed,
    recordStrategyDecision,
    pruneTradesOlderThan,
    close,
  };
};
