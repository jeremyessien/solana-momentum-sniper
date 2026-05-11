import { createSystemClock } from '../src/infrastructure/clock/clock.js';
import { loadConfig } from '../src/infrastructure/config/configLoader.js';
import { createEventBus } from '../src/infrastructure/eventBus/eventBus.js';
import { createHeliusAdapter } from '../src/infrastructure/helius/heliusAdapter.js';
import { createKitSubscriptionSource } from '../src/infrastructure/helius/kitSubscriptionSource.js';
import { createLogger } from '../src/infrastructure/logger/logger.js';
import type { EventMap } from '../src/shared/eventMap.js';
import { PUMP_FUN_PROGRAM_ID } from '../src/shared/launchpadPrograms.js';

const RUN_DURATION_MS = 60_000;

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  if (cfg.kind === 'err') {
    console.error('config load failed:', cfg.error.issues);
    process.exit(1);
  }
  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${cfg.value.HELIUS_API_KEY}`;
  const logger = createLogger({ level: 'warn', isDevelopment: true });
  const eventBus = createEventBus<EventMap>();
  const adapter = createHeliusAdapter({
    source: createKitSubscriptionSource(wsUrl),
    clock: createSystemClock(),
    logger,
    publishLog: (e) => eventBus.publish('rawProgramLogReceived', e),
  });

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), RUN_DURATION_MS);

  console.log(
    `watching Pump.fun for ${RUN_DURATION_MS / 1000}s to measure same-tx Create+Trade frequency...`,
  );

  const stream = eventBus.iterate('rawProgramLogReceived', { signal: ctrl.signal });
  const adapterPromise = adapter
    .start(PUMP_FUN_PROGRAM_ID, { signal: ctrl.signal })
    .catch((err) => {
      if (!ctrl.signal.aborted) console.error('adapter failed:', err);
    });

  let totalTransactions = 0;
  let errored = 0;
  let withCreate = 0;
  let withBuy = 0;
  let withSell = 0;
  let createOnly = 0;
  let createAndBuy = 0;
  let createAndSell = 0;
  let createAndTrade = 0;

  for await (const event of stream) {
    totalTransactions++;
    if (event.err !== null) {
      errored++;
      continue;
    }

    const hasCreate = event.logs.some(
      (l) => l === 'Program log: Instruction: CreateV2' || l === 'Program log: Instruction: Create',
    );
    const hasBuy = event.logs.some((l) => l === 'Program log: Instruction: Buy');
    const hasSell = event.logs.some((l) => l === 'Program log: Instruction: Sell');

    if (hasCreate) withCreate++;
    if (hasBuy) withBuy++;
    if (hasSell) withSell++;

    if (hasCreate && !hasBuy && !hasSell) createOnly++;
    if (hasCreate && hasBuy) createAndBuy++;
    if (hasCreate && hasSell) createAndSell++;
    if (hasCreate && (hasBuy || hasSell)) createAndTrade++;
  }

  await adapterPromise;

  const pctOfCreates = (n: number): string =>
    withCreate > 0 ? `${((n / withCreate) * 100).toFixed(1)}%` : '—';

  console.log(`\n=== Same-tx Create+Trade frequency report ===`);
  console.log(`Total transactions observed:  ${totalTransactions}`);
  console.log(`  Errored (skipped):          ${errored}`);
  console.log(`  With Create (any variant):  ${withCreate}`);
  console.log(`  With Buy:                   ${withBuy}`);
  console.log(`  With Sell:                  ${withSell}`);
  console.log(`\n--- Of transactions with a Create ---`);
  console.log(`Create only:                  ${createOnly}  (${pctOfCreates(createOnly)})`);
  console.log(`Create + Buy:                 ${createAndBuy}  (${pctOfCreates(createAndBuy)})`);
  console.log(`Create + Sell:                ${createAndSell}  (${pctOfCreates(createAndSell)})`);
  console.log(`Create + Any Trade:           ${createAndTrade}  (${pctOfCreates(createAndTrade)})`);
  console.log(
    `\nRace-condition trigger rate: ${pctOfCreates(createAndTrade)} of detected launches.`,
  );
};

await main();
