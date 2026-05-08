import { describe, expect, test } from 'vitest';
import { createLogger } from './logger.js';

type CaptureDestination = {
  readonly lines: string[];
  readonly write: (chunk: string) => void;
};

const captureDestination = (): CaptureDestination => {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string): void {
      lines.push(chunk);
    },
  };
};

type ParsedLogEntry = {
  readonly level: number;
  readonly time: number;
  readonly msg: string;
  readonly mint?: string;
  readonly slot?: number;
  readonly module?: string;
};

const parseFirstLine = (lines: readonly string[]): ParsedLogEntry => {
  const first = lines[0];
  if (first === undefined) {
    throw new Error('expected at least one captured log line');
  }
  return JSON.parse(first) as ParsedLogEntry;
};

describe('createLogger', () => {
  test('emits structured JSON with severity, message, and custom fields', () => {
    const dest = captureDestination();
    const logger = createLogger({ level: 'info', isDevelopment: false }, dest);

    logger.info({ mint: 'abc123', slot: 42 }, 'token detected');

    expect(dest.lines).toHaveLength(1);
    const entry = parseFirstLine(dest.lines);
    expect(entry.msg).toBe('token detected');
    expect(entry.level).toBe(30);
    expect(entry.mint).toBe('abc123');
    expect(entry.slot).toBe(42);
    expect(typeof entry.time).toBe('number');
  });

  test('child logger inherits parent context and extends with its own', () => {
    const dest = captureDestination();
    const parent = createLogger({ level: 'info', isDevelopment: false }, dest);
    const child = parent.child({ module: 'tokenDetection' });

    child.info({ mint: 'abc123' }, 'token detected');

    expect(dest.lines).toHaveLength(1);
    const entry = parseFirstLine(dest.lines);
    expect(entry.module).toBe('tokenDetection');
    expect(entry.mint).toBe('abc123');
    expect(entry.msg).toBe('token detected');
  });
});
