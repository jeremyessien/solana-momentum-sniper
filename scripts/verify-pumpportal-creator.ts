// Fidelity audit: for each captured Pump.fun sample, fetch the create tx and
// decode the on-chain creator and virtual_sol_reserves with our borsh parser,
// then compare to PumpPortal's traderPublicKey and vSolInBondingCurve.
// Run: pnpm exec tsx --env-file=.env scripts/verify-pumpportal-creator.ts

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSolanaRpc, signature } from '@solana/kit';
import { parsePumpfunCreate } from '../src/detection/pumpfunCreateParser.js';
import { loadConfig } from '../src/infrastructure/config/configLoader.js';
import type { ProgramLogEvent } from '../src/shared/programLogEvent.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures',
);

type PumpSample = {
  readonly name?: string;
  readonly pool: string;
  readonly signature: string;
  readonly traderPublicKey: string;
  readonly vSolInBondingCurve: number;
};

const loadPumpSamples = (): readonly PumpSample[] => {
  const all = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, 'pumpportal-newtoken-samples.json'), 'utf-8'),
  ) as readonly Partial<PumpSample>[];
  return all.filter(
    (s): s is PumpSample =>
      s.pool === 'pump' &&
      typeof s.signature === 'string' &&
      typeof s.traderPublicKey === 'string' &&
      typeof s.vSolInBondingCurve === 'number',
  );
};

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  if (cfg.kind === 'err') {
    console.error('config load failed:', cfg.error.issues);
    process.exit(1);
  }

  const rpc = createSolanaRpc(
    `https://mainnet.helius-rpc.com/?api-key=${cfg.value.HELIUS_API_KEY}`,
  );

  let checked = 0;
  let creatorMatches = 0;
  let liquidityMatches = 0;

  for (const sample of loadPumpSamples()) {
    const label = sample.name ?? sample.signature.slice(0, 8);
    try {
      const tx = await rpc
        .getTransaction(signature(sample.signature), {
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
          commitment: 'confirmed',
        })
        .send();

      if (tx === null) {
        console.log(`${label}: transaction not found (may be pruned by RPC)`);
        continue;
      }

      const event: ProgramLogEvent = {
        signature: sample.signature,
        slot: tx.slot,
        logs: tx.meta?.logMessages ?? [],
        err: tx.meta?.err ?? null,
      };

      const token = parsePumpfunCreate(event, {
        internalId: randomUUID(),
        detectedAt: new Date(),
      });
      if (token === null) {
        console.log(`${label}: could not decode a create event from the tx logs`);
        continue;
      }

      checked += 1;

      const creatorMatch = token.creatorWallet === sample.traderPublicKey;
      if (creatorMatch) creatorMatches += 1;

      const pumpPortalLamports = BigInt(Math.round(sample.vSolInBondingCurve * LAMPORTS_PER_SOL));
      const liquidityMatch = token.initialLiquidityLamports === pumpPortalLamports;
      if (liquidityMatch) liquidityMatches += 1;

      console.log(`${label}:`);
      console.log(
        `  creator   ${creatorMatch ? 'MATCH   ' : 'MISMATCH'}  on-chain=${token.creatorWallet}  pumpportal=${sample.traderPublicKey}`,
      );
      console.log(
        `  liquidity ${liquidityMatch ? 'MATCH   ' : 'MISMATCH'}  on-chain=${token.initialLiquidityLamports}  pumpportal=${pumpPortalLamports}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`${label}: RPC error — ${message}`);
    }
  }

  console.log(`\ncreator:   ${creatorMatches}/${checked} matched`);
  console.log(`liquidity: ${liquidityMatches}/${checked} matched`);
  process.exit(0);
};

await main();
