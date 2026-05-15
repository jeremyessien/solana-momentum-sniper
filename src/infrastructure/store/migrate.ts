import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/logger.js';

export type ParsedMigration = {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
};

export type MigrationApplyError =
  | { readonly kind: 'gap'; readonly missing: number; readonly found: readonly number[] }
  | {
      readonly kind: 'downgrade';
      readonly databaseVersion: number;
      readonly maxFileVersion: number;
    }
  | { readonly kind: 'duplicate'; readonly version: number }
  | { readonly kind: 'malformed-filename'; readonly filename: string };

export class MigrationError extends Error {
  constructor(readonly detail: MigrationApplyError) {
    super(formatDetail(detail));
    this.name = 'MigrationError';
  }
}

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export const parseMigrations = (filenames: readonly string[]): readonly ParsedMigration[] => {
  const parsed: ParsedMigration[] = [];
  for (const filename of filenames) {
    if (!filename.endsWith('.sql')) continue;
    const match = FILENAME_PATTERN.exec(filename);
    if (match === null) {
      throw new MigrationError({ kind: 'malformed-filename', filename });
    }
    const versionStr = match[1];
    const name = match[2];
    if (versionStr === undefined || name === undefined) {
      throw new MigrationError({ kind: 'malformed-filename', filename });
    }
    parsed.push({ version: Number.parseInt(versionStr, 10), name, filename });
  }
  parsed.sort((a, b) => a.version - b.version);

  const seen = new Set<number>();
  for (const m of parsed) {
    if (seen.has(m.version)) {
      throw new MigrationError({ kind: 'duplicate', version: m.version });
    }
    seen.add(m.version);
  }
  for (let i = 0; i < parsed.length; i += 1) {
    const expected = i + 1;
    const found = parsed[i];
    if (found === undefined || found.version !== expected) {
      throw new MigrationError({
        kind: 'gap',
        missing: expected,
        found: parsed.map((p) => p.version),
      });
    }
  }

  return parsed;
};

export const applyMigrations = (deps: {
  readonly db: Database.Database;
  readonly migrationsDir: string;
  readonly logger: Logger;
}): void => {
  const filenames = readdirSync(deps.migrationsDir);
  const migrations = parseMigrations(filenames);

  const currentRow = deps.db.prepare('PRAGMA user_version').get() as {
    user_version: number | bigint;
  };
  const currentVersion = Number(currentRow.user_version);
  const maxVersion =
    migrations.length === 0 ? 0 : (migrations[migrations.length - 1]?.version ?? 0);

  if (currentVersion > maxVersion) {
    throw new MigrationError({
      kind: 'downgrade',
      databaseVersion: currentVersion,
      maxFileVersion: maxVersion,
    });
  }

  if (currentVersion === maxVersion) {
    deps.logger.debug({ version: currentVersion }, 'database schema up to date');
    return;
  }

  const pending = migrations.filter((m) => m.version > currentVersion);
  deps.logger.info(
    { from: currentVersion, to: maxVersion, count: pending.length },
    'applying database migrations',
  );

  for (const migration of pending) {
    const sql = readFileSync(join(deps.migrationsDir, migration.filename), 'utf8');
    const tx = deps.db.transaction(() => {
      deps.db.exec(sql);
      deps.db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    tx();
    deps.logger.info({ version: migration.version, name: migration.name }, 'migration applied');
  }
};

const formatDetail = (d: MigrationApplyError): string => {
  switch (d.kind) {
    case 'gap':
      return `migration gap: expected ${d.missing}, found versions ${d.found.join(', ')}`;
    case 'downgrade':
      return `database version ${d.databaseVersion} is newer than max migration ${d.maxFileVersion}`;
    case 'duplicate':
      return `duplicate migration version ${d.version}`;
    case 'malformed-filename':
      return `malformed migration filename: ${d.filename}`;
  }
};
