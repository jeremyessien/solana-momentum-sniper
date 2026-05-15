import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { applyMigrations, MigrationError, parseMigrations } from './migrate.js';

const silentLogger = pino({ level: 'silent' });

const fixturesDir = (): string => mkdtempSync(join(tmpdir(), 'migrate-test-'));

const writeMigration = (dir: string, filename: string, sql: string): void => {
  writeFileSync(join(dir, filename), sql, 'utf8');
};

const readUserVersion = (db: Database.Database): number => {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number | bigint };
  return Number(row.user_version);
};

describe('parseMigrations', () => {
  test('sorts mixed input by version', () => {
    const parsed = parseMigrations(['0003_three.sql', '0001_one.sql', '0002_two.sql']);
    expect(parsed.map((m) => m.version)).toEqual([1, 2, 3]);
  });

  test('skips non-sql files', () => {
    const parsed = parseMigrations(['0001_one.sql', 'README.md', '.DS_Store']);
    expect(parsed.map((m) => m.filename)).toEqual(['0001_one.sql']);
  });

  test('rejects gaps in version numbering', () => {
    expect(() => parseMigrations(['0001_a.sql', '0003_c.sql'])).toThrow(MigrationError);
  });

  test('rejects duplicate version numbers', () => {
    expect(() => parseMigrations(['0001_a.sql', '0001_b.sql'])).toThrow(MigrationError);
  });

  test('rejects malformed filename', () => {
    expect(() => parseMigrations(['init.sql'])).toThrow(MigrationError);
  });

  test('returns empty array for empty input', () => {
    expect(parseMigrations([])).toEqual([]);
  });
});

describe('applyMigrations', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fixturesDir();
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('applies a single migration on a fresh database', () => {
    writeMigration(dir, '0001_initial.sql', 'CREATE TABLE foo (x INTEGER);');

    applyMigrations({ db, migrationsDir: dir, logger: silentLogger });

    expect(readUserVersion(db)).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test('applies multiple migrations in order', () => {
    writeMigration(dir, '0001_one.sql', 'CREATE TABLE a (x INTEGER);');
    writeMigration(dir, '0002_two.sql', 'CREATE TABLE b (x INTEGER);');
    writeMigration(dir, '0003_three.sql', 'CREATE TABLE c (x INTEGER);');

    applyMigrations({ db, migrationsDir: dir, logger: silentLogger });

    expect(readUserVersion(db)).toBe(3);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    expect(names).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  });

  test('is idempotent — second run is a no-op', () => {
    writeMigration(dir, '0001_initial.sql', 'CREATE TABLE foo (x INTEGER);');

    applyMigrations({ db, migrationsDir: dir, logger: silentLogger });
    applyMigrations({ db, migrationsDir: dir, logger: silentLogger });

    expect(readUserVersion(db)).toBe(1);
  });

  test('is idempotent under defaultSafeIntegers (PRAGMA returns bigint)', () => {
    db.defaultSafeIntegers(true);
    writeMigration(dir, '0001_initial.sql', 'CREATE TABLE foo (x INTEGER);');

    applyMigrations({ db, migrationsDir: dir, logger: silentLogger });
    expect(readUserVersion(db)).toBe(1);

    applyMigrations({ db, migrationsDir: dir, logger: silentLogger });
    expect(readUserVersion(db)).toBe(1);
  });

  test('applies only pending migrations when partially up-to-date', () => {
    writeMigration(dir, '0001_one.sql', 'CREATE TABLE a (x INTEGER);');
    applyMigrations({ db, migrationsDir: dir, logger: silentLogger });

    writeMigration(dir, '0002_two.sql', 'CREATE TABLE b (x INTEGER);');
    applyMigrations({ db, migrationsDir: dir, logger: silentLogger });

    expect(readUserVersion(db)).toBe(2);
  });

  test('rolls back when a migration fails and leaves user_version unchanged', () => {
    writeMigration(dir, '0001_ok.sql', 'CREATE TABLE foo (x INTEGER);');
    applyMigrations({ db, migrationsDir: dir, logger: silentLogger });
    expect(readUserVersion(db)).toBe(1);

    writeMigration(dir, '0002_broken.sql', 'CREATE TABLE bar (x INTEGER); NOT_VALID_SQL;');

    expect(() => applyMigrations({ db, migrationsDir: dir, logger: silentLogger })).toThrow();

    expect(readUserVersion(db)).toBe(1);
    const barTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bar'")
      .all();
    expect(barTable).toHaveLength(0);
  });

  test('refuses to run when database version is higher than max migration', () => {
    db.exec('PRAGMA user_version = 99');
    writeMigration(dir, '0001_one.sql', 'CREATE TABLE foo (x INTEGER);');

    expect(() => applyMigrations({ db, migrationsDir: dir, logger: silentLogger })).toThrow(
      MigrationError,
    );
  });
});
