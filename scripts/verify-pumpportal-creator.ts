// Verifies whether PumpPortal's `traderPublicKey` equals the on-chain `creator`
// field our borsh parser reads. Run: pnpm exec tsx --env-file=.env scripts/verify-pumpportal-creator.ts

import { randomUUID } from 'node:crypto';
import { createSolanaRpc, signature } from '@solana/kit';
import { parsePumpfunCreate } from '../src/detection/pumpfunCreateParser.js';
import { loadConfig } from '../src/infrastructure/config/configLoader.js';
import type { ProgramLogEvent } from '../src/shared/programLogEvent.js';

type Sample = {
  readonly name: string;
  readonly signature: string;
  readonly traderPublicKey: string;
};

const SAMPLES: readonly Sample[] = [
  {
    name: 'Cat King',
    signature:
      '44NjxVb5UvktLMZNWh9BxUwJH4fKYrQVfhowp3TswLoF1kzwCaj2CzWpYBh176AzNWyFVurVcx7bXFE9EGehqJKi',
    traderPublicKey: '3VF7CW2JqRU79yq3WCHdGY67BA6x3UtBxzrTPE1cdTqk',
  },
  {
    name: 'Beer',
    signature:
      'vXEnxQsPhZTRDX8xd1TRq8zE3AC6SEeKTunfqotj234JEkqoB8gt47mncQdqpHM3FnA3RwEmCo9HELezX5QsiGY',
    traderPublicKey: '3dtGUdA8n2Cxisz7apxAgpqSPgaGDuyqd7PYzt9d1byD',
  },
  {
    name: 'temple',
    signature:
      '24EVV4LZKwwgMgXB87V75TYLpCbMqqWoGehPCh24jRGLwT1qehsEny8nfFU6MxZVtfiWgjefEZmAci4WaWRw5m5s',
    traderPublicKey: 'XYzpNoUbN2C7iE8SHCTu4kynvFueMCzSjibs1yNLySn',
  },
  {
    name: 'sandy',
    signature:
      'r3Am8FZjV6LWKNRPZ1oCLYbmYGULEQsKi7KXMqa754gj8m6cZZyoDMZ8cWUnjUrX31xpbJadKb9T33qCriQum55',
    traderPublicKey: 'BqJLQYYwhL6EJkuq39zB8FWSaHeQr94x4X1CY6c1DqGT',
  },
];

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
  let matched = 0;

  for (const sample of SAMPLES) {
    try {
      const tx = await rpc
        .getTransaction(signature(sample.signature), {
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
          commitment: 'confirmed',
        })
        .send();

      if (tx === null) {
        console.log(`${sample.name}: transaction not found (may be pruned by RPC)`);
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
        console.log(`${sample.name}: could not decode a create event from the tx logs`);
        continue;
      }

      checked += 1;
      const isMatch = token.creatorWallet === sample.traderPublicKey;
      if (isMatch) matched += 1;

      console.log(`${sample.name}: ${isMatch ? 'MATCH' : 'MISMATCH'}`);
      console.log(`  on-chain creator : ${token.creatorWallet}`);
      console.log(`  traderPublicKey  : ${sample.traderPublicKey}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`${sample.name}: RPC error — ${message}`);
    }
  }

  console.log(`\n${matched}/${checked} decoded samples matched (of ${SAMPLES.length} attempted).`);
  process.exit(0);
};

await main();
