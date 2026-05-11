import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, GrammyError } from 'grammy';
import type { Logger } from '../logger/logger.js';

export type TelegramBotApi = {
  readonly sendMessage: (
    chatId: number,
    text: string,
    options: { parse_mode: 'HTML' },
  ) => Promise<unknown>;
  readonly getMe: () => Promise<{ username: string }>;
};

export const createGrammyBotApi = (token: string): TelegramBotApi => {
  const bot = new Bot(token);
  bot.api.config.use(apiThrottler());
  return {
    sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options),
    getMe: async () => {
      const me = await bot.api.getMe();
      return { username: me.username };
    },
  };
};

export type TelegramClient = {
  readonly sendMessage: (text: string) => Promise<void>;
  readonly getBotUsername: () => Promise<string>;
};

export type TelegramClientConfig = {
  readonly botApi: TelegramBotApi;
  readonly recipientChatId: number;
  readonly logger: Logger;
};

export const createTelegramClient = (config: TelegramClientConfig): TelegramClient => {
  const sendMessage = async (text: string): Promise<void> => {
    try {
      await config.botApi.sendMessage(config.recipientChatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 403) {
        config.logger.error(
          { recipientChatId: config.recipientChatId, description: err.description },
          'Telegram 403 Forbidden: the recipient has not started a chat with the bot or has blocked it. Open Telegram, find the bot, and send /start.',
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      config.logger.warn(
        { err: message, recipientChatId: config.recipientChatId },
        'Telegram sendMessage failed',
      );
    }
  };

  const getBotUsername = async (): Promise<string> => {
    const me = await config.botApi.getMe();
    return me.username;
  };

  return { sendMessage, getBotUsername };
};
