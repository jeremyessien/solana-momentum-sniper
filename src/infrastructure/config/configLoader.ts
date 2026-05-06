import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result.js';

const ConfigSchema = z.object({
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_PATH: z.string().min(1).default('./data/moonscout.db'),
  HELIUS_API_KEY: z.string().min(1, 'HELIUS_API_KEY is required'),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_USER_ID_WHITELIST: z
    .string()
    .min(1, 'TELEGRAM_USER_ID_WHITELIST is required')
    .transform((raw, ctx) => {
      const ids = raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'must contain at least one user ID',
        });
        return z.NEVER;
      }
      const parsed: number[] = [];
      for (const id of ids) {
        const n = Number(id);
        if (!Number.isInteger(n) || n <= 0) {
          ctx.addIssue({
            code: 'custom',
            message: `'${id}' is not a positive integer`,
          });
          return z.NEVER;
        }
        parsed.push(n);
      }
      return parsed;
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

export type ConfigLoadError = {
  readonly kind: 'invalid';
  readonly issues: readonly string[];
};

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
): Result<Config, ConfigLoadError> => {
  const result = ConfigSchema.safeParse(env);
  if (result.success) {
    return ok(result.data);
  }
  return err({
    kind: 'invalid',
    issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  });
};
