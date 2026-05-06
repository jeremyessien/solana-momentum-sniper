import { describe, expect, test } from 'vitest';
import { loadConfig } from './configLoader.js';

describe('loadConfig', () => {
  const validEnv = {
    HELIUS_API_KEY: 'test-helius-key',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_USER_ID_WHITELIST: '12345',
  };

  test('parses a valid environment into ok(config)', () => {
    const result = loadConfig({
      ...validEnv,
      LOG_LEVEL: 'debug',
      DATABASE_PATH: '/tmp/test.db',
    });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.LOG_LEVEL).toBe('debug');
      expect(result.value.DATABASE_PATH).toBe('/tmp/test.db');
      expect(result.value.HELIUS_API_KEY).toBe('test-helius-key');
      expect(result.value.TELEGRAM_BOT_TOKEN).toBe('123:abc');
      expect(result.value.TELEGRAM_USER_ID_WHITELIST).toEqual([12345]);
    }
  });

  test('applies defaults when LOG_LEVEL and DATABASE_PATH are omitted', () => {
    const result = loadConfig(validEnv);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.LOG_LEVEL).toBe('info');
      expect(result.value.DATABASE_PATH).toBe('./data/moonscout.db');
    }
  });

  test('errors when HELIUS_API_KEY is missing', () => {
    const result = loadConfig({
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_USER_ID_WHITELIST: '12345',
    });

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('invalid');
      expect(result.error.issues.some((i) => i.includes('HELIUS_API_KEY'))).toBe(true);
    }
  });

  test('errors on invalid LOG_LEVEL', () => {
    const result = loadConfig({ ...validEnv, LOG_LEVEL: 'verbose' });

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.issues.some((i) => i.includes('LOG_LEVEL'))).toBe(true);
    }
  });

  test('parses comma-separated TELEGRAM_USER_ID_WHITELIST into number array', () => {
    const result = loadConfig({
      ...validEnv,
      TELEGRAM_USER_ID_WHITELIST: '111, 222, 333',
    });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.TELEGRAM_USER_ID_WHITELIST).toEqual([111, 222, 333]);
    }
  });

  test('errors on non-numeric TELEGRAM_USER_ID_WHITELIST entry', () => {
    const result = loadConfig({
      ...validEnv,
      TELEGRAM_USER_ID_WHITELIST: '111,abc,333',
    });

    expect(result.kind).toBe('err');
  });
});
