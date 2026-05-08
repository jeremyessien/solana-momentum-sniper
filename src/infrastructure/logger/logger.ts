import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export type LoggerConfig = {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly isDevelopment: boolean;
};

export const createLogger = (config: LoggerConfig, destination?: DestinationStream): Logger => {
  const baseOptions = { level: config.level };

  if (destination !== undefined) {
    return pino(baseOptions, destination);
  }

  if (config.isDevelopment) {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino(baseOptions);
};
