CREATE TABLE lifecycle_events (
  sequence_number   INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at_ms    INTEGER NOT NULL,
  event_type        TEXT    NOT NULL,
  token_internal_id TEXT,
  payload           TEXT    NOT NULL,
  metadata          TEXT
);

CREATE INDEX lifecycle_events_by_type_time
  ON lifecycle_events (event_type, occurred_at_ms);

CREATE INDEX lifecycle_events_by_token
  ON lifecycle_events (token_internal_id)
  WHERE token_internal_id IS NOT NULL;

CREATE INDEX lifecycle_events_by_occurred_at
  ON lifecycle_events (occurred_at_ms);

CREATE TABLE trade_events (
  sequence_number      INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at_ms       INTEGER NOT NULL,
  token_internal_id    TEXT    NOT NULL,
  mint                 TEXT    NOT NULL,
  trader_wallet        TEXT    NOT NULL,
  side                 TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
  sol_amount_lamports  INTEGER NOT NULL,
  token_amount         INTEGER NOT NULL,
  slot                 INTEGER NOT NULL,
  signature            TEXT    NOT NULL,
  payload              TEXT    NOT NULL
);

CREATE UNIQUE INDEX trade_events_idempotency
  ON trade_events (token_internal_id, signature);

CREATE INDEX trade_events_by_token_time
  ON trade_events (token_internal_id, occurred_at_ms);

CREATE INDEX trade_events_by_occurred_at
  ON trade_events (occurred_at_ms);

CREATE TABLE tracked_tokens (
  token_internal_id  TEXT PRIMARY KEY,
  mint               TEXT NOT NULL UNIQUE,
  launchpad          TEXT NOT NULL,
  creator_wallet     TEXT NOT NULL,
  detected_at_ms     INTEGER NOT NULL,
  enrichment_status  TEXT NOT NULL CHECK (enrichment_status IN ('pending', 'completed', 'failed')),
  tracking_status    TEXT NOT NULL CHECK (tracking_status IN ('active', 'graduated', 'timeout')),
  closed_at_ms       INTEGER,
  last_event_seq     INTEGER NOT NULL
);

CREATE INDEX tracked_tokens_by_enrichment_status
  ON tracked_tokens (enrichment_status);

CREATE INDEX tracked_tokens_by_tracking_status
  ON tracked_tokens (tracking_status);