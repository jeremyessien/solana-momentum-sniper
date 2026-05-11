import { GrammyError } from 'grammy';
import { describe, expect, test, vi } from 'vitest';
import { createLogger, type Logger } from '../logger/logger.js';
import { createTelegramClient, type TelegramBotApi } from './telegramClient.js';

const silentLogger = (): Logger =>
  createLogger({ level: 'error', isDevelopment: false }, { write: () => {} });

const capturingLogger = (): { logger: Logger; lines: string[] } => {
  const lines: string[] = [];
  const logger = createLogger(
    { level: 'info', isDevelopment: false },
    {
      write: (line) => {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
};

type LogLineShape = {
  readonly level: number;
  readonly msg: string;
  readonly recipientChatId?: number;
  readonly err?: string;
  readonly description?: string;
};

const makeStubBotApi = (overrides: Partial<TelegramBotApi> = {}): TelegramBotApi => ({
  sendMessage: overrides.sendMessage ?? vi.fn().mockResolvedValue({}),
  getMe: overrides.getMe ?? vi.fn().mockResolvedValue({ username: 'stubbot' }),
});

describe('createTelegramClient', () => {
  test('sendMessage calls botApi with the configured chat id and HTML parse mode', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const botApi = makeStubBotApi({ sendMessage });
    const client = createTelegramClient({
      botApi,
      recipientChatId: 12345,
      logger: silentLogger(),
    });

    await client.sendMessage('<b>hello</b>');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(12345, '<b>hello</b>', { parse_mode: 'HTML' });
  });

  test('logs an error and swallows the exception on 403 Forbidden', async () => {
    const error403 = new GrammyError(
      'Forbidden: bot was blocked by the user',
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      'sendMessage',
      {},
    );
    const sendMessage = vi.fn().mockRejectedValue(error403);
    const { logger, lines } = capturingLogger();

    const client = createTelegramClient({
      botApi: makeStubBotApi({ sendMessage }),
      recipientChatId: 12345,
      logger,
    });

    await expect(client.sendMessage('any')).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as LogLineShape;
    expect(entry.level).toBe(50);
    expect(entry.msg).toContain('403');
    expect(entry.recipientChatId).toBe(12345);
  });

  test('logs a warning and swallows the exception on a non-403 GrammyError', async () => {
    const error500 = new GrammyError(
      'Internal Server Error',
      { ok: false, error_code: 500, description: 'Internal Server Error' },
      'sendMessage',
      {},
    );
    const sendMessage = vi.fn().mockRejectedValue(error500);
    const { logger, lines } = capturingLogger();

    const client = createTelegramClient({
      botApi: makeStubBotApi({ sendMessage }),
      recipientChatId: 12345,
      logger,
    });

    await expect(client.sendMessage('any')).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as LogLineShape;
    expect(entry.level).toBe(40);
  });

  test('logs a warning and swallows the exception on a non-GrammyError throw', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new TypeError('network down'));
    const { logger, lines } = capturingLogger();

    const client = createTelegramClient({
      botApi: makeStubBotApi({ sendMessage }),
      recipientChatId: 12345,
      logger,
    });

    await expect(client.sendMessage('any')).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as LogLineShape;
    expect(entry.level).toBe(40);
    expect(entry.err).toBe('network down');
  });

  test('getBotUsername returns the username from botApi.getMe', async () => {
    const getMe = vi.fn().mockResolvedValue({ username: 'moonscout_bot' });
    const client = createTelegramClient({
      botApi: makeStubBotApi({ getMe }),
      recipientChatId: 12345,
      logger: silentLogger(),
    });

    const username = await client.getBotUsername();

    expect(username).toBe('moonscout_bot');
    expect(getMe).toHaveBeenCalledTimes(1);
  });
});
