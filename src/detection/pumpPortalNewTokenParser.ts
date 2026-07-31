import { z } from 'zod';
import type { DetectedToken } from '../shared/detectedToken.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

const pumpNewTokenSchema = z.looseObject({
  txType: z.literal('create'),
  pool: z.literal('pump'),
  mint: z.string().min(1),
  traderPublicKey: z.string().min(1),
  vSolInBondingCurve: z.number(),
});

export type ParsePumpPortalNewTokenOptions = {
  readonly internalId: string;
  readonly detectedAt: Date;
};

export const parsePumpPortalNewToken = (
  rawFrame: string,
  options: ParsePumpPortalNewTokenOptions,
): DetectedToken | null => {
  let json: unknown;
  try {
    json = JSON.parse(rawFrame);
  } catch {
    return null;
  }

  const parsed = pumpNewTokenSchema.safeParse(json);
  if (!parsed.success) return null;

  const { mint, traderPublicKey, vSolInBondingCurve } = parsed.data;
  if (vSolInBondingCurve < 0) return null;
  const lamports = Math.round(vSolInBondingCurve * LAMPORTS_PER_SOL);
  if (!Number.isSafeInteger(lamports)) return null;

  return {
    internalId: options.internalId,
    mint,
    launchpad: 'pumpfun',
    // Launch signer, not the on-chain `creator` the log parser reads; verified to
    // diverge on some launches. Not for creator-based signals until resolved on-chain.
    creatorWallet: traderPublicKey,
    initialLiquidityLamports: BigInt(lamports),
    detectedAt: options.detectedAt,
  };
};
