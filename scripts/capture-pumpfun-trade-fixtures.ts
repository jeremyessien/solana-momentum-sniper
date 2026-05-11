import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSystemClock } from '../src/infrastructure/clock/clock.js';
import { loadConfig } from '../src/infrastructure/config/configLoader.js';
import { createEventBus } from '../src/infrastructure/eventBus/eventBus.js';
import { createHeliusAdapter } from '../src/infrastructure/helius/heliusAdapter.js';
import { createKitSubscriptionSource } from '../src/infrastructure/helius/kitSubscriptionSource.js';
import { createLogger } from '../src/infrastructure/logger/logger.js';
import type { EventMap } from '../src/shared/eventMap.js';
import { PUMP_FUN_PROGRAM_ID } from '../src/shared/launchpadPrograms.js';

const TARGET_BUY_SAMPLES = 2;
const TARGET_SELL_SAMPLES = 2;
const TARGET_COMPLETE_SAMPLES = 1;
const MAX_DURATION_MS = 180_000;

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures',
);

const writeFixture = (
  filename: string,
  purpose: string,
  event: { signature: string; slot: bigint; logs: readonly string[] },
): void => {
  const samplePath = path.join(FIXTURES_DIR, filename);
  const payload = {
    _notes: {
      captured: new Date().toISOString(),
      purpose,
    },
    transaction: {
      signature: event.signature,
      slot: event.slot.toString(),
      logs: event.logs,
    },
  };
  writeFileSync(samplePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
};

const main = async (): Promise<void> => {
  const result = loadConfig();
  if (result.kind === 'err') {
    console.error('Config load failed:', result.error.issues);
    process.exit(1);
  }
  const config = result.value;

  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
  const logger = createLogger({
    level: 'warn',
    isDevelopment: false,
  });

  const eventBus = createEventBus<EventMap>();
  const adapter = createHeliusAdapter({
    source: createKitSubscriptionSource(wsUrl),
    clock: createSystemClock(),
    logger,
    publishLog: (event) => eventBus.publish('rawProgramLogReceived', event),
  });

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), MAX_DURATION_MS);

  console.log(
    `capturing trade fixtures: target ${TARGET_BUY_SAMPLES} buy + ${TARGET_SELL_SAMPLES} sell + ${TARGET_COMPLETE_SAMPLES} complete, max ${MAX_DURATION_MS / 1000}s`,
  );

  const stream = eventBus.iterate('rawProgramLogReceived', { signal: ctrl.signal });
  const adapterPromise = adapter
    .start(PUMP_FUN_PROGRAM_ID, { signal: ctrl.signal })
    .catch((err: unknown) => {
      if (!ctrl.signal.aborted) {
        console.error('adapter failed:', err);
        ctrl.abort();
      }
    });

  let buyCaptured = 0;
  let sellCaptured = 0;
  let completeCaptured = 0;

  const done = (): boolean =>
    buyCaptured >= TARGET_BUY_SAMPLES &&
    sellCaptured >= TARGET_SELL_SAMPLES &&
    completeCaptured >= TARGET_COMPLETE_SAMPLES;

  for await (const event of stream) {
    if (event.err !== null) continue;

    const hasBuy = event.logs.some((l) => l === 'Program log: Instruction: Buy');
    const hasSell = event.logs.some((l) => l === 'Program log: Instruction: Sell');
    const hasMigrate = event.logs.some(
      (l) =>
        l === 'Program log: Instruction: Migrate' || l === 'Program log: Instruction: Withdraw',
    );
    const hasCreate = event.logs.some(
      (l) => l === 'Program log: Instruction: CreateV2' || l === 'Program log: Instruction: Create',
    );

    if (hasBuy && !hasCreate && buyCaptured < TARGET_BUY_SAMPLES) {
      buyCaptured++;
      const filename =
        buyCaptured === 1
          ? 'pumpfun-trade-buy-sample.json'
          : `pumpfun-trade-buy-sample-${buyCaptured}.json`;
      writeFixture(
        filename,
        'Pump.fun Buy TradeEvent captured live for parser test coverage.',
        event,
      );
      console.log(`  buy ${buyCaptured}/${TARGET_BUY_SAMPLES}  ${event.signature}`);
    }

    if (hasSell && !hasCreate && sellCaptured < TARGET_SELL_SAMPLES) {
      sellCaptured++;
      const filename =
        sellCaptured === 1
          ? 'pumpfun-trade-sell-sample.json'
          : `pumpfun-trade-sell-sample-${sellCaptured}.json`;
      writeFixture(
        filename,
        'Pump.fun Sell TradeEvent captured live for parser test coverage.',
        event,
      );
      console.log(`  sell ${sellCaptured}/${TARGET_SELL_SAMPLES}  ${event.signature}`);
    }

    if (hasMigrate && completeCaptured < TARGET_COMPLETE_SAMPLES) {
      completeCaptured++;
      const filename = 'pumpfun-complete-sample.json';
      writeFixture(
        filename,
        'Pump.fun Migrate/CompleteEvent captured live for parser test coverage.',
        event,
      );
      console.log(`  complete ${completeCaptured}/${TARGET_COMPLETE_SAMPLES}  ${event.signature}`);
    }

    if (done()) {
      ctrl.abort();
      break;
    }
  }

  await adapterPromise;
  console.log(
    `\ncapture ended: ${buyCaptured} buy, ${sellCaptured} sell, ${completeCaptured} complete`,
  );
};

await main();
