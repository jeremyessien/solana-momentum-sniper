import { randomUUID } from 'node:crypto';
import { createSystemClock } from '../src/infrastructure/clock/clock.js';
import { createLogger } from '../src/infrastructure/logger/logger.js';
import { createPumpPortalSource } from '../src/infrastructure/pumpportal/pumpPortalSource.js';
import { createRugCheckClient } from '../src/infrastructure/rugcheck/rugCheckClient.js';
import type { DetectedToken } from '../src/shared/detectedToken.js';

const SAMPLE_SIZE = 5;
const PROBE_OFFSETS_MS = [15_000, 45_000, 90_000, 180_000, 300_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const main = async (): Promise<void> => {
  const clock = createSystemClock();
  const logger = createLogger({ level: 'error', isDevelopment: true });
  const rugcheck = createRugCheckClient({ clock });

  const collected: DetectedToken[] = [];
  const ctrl = new AbortController();

  const source = createPumpPortalSource({
    clock,
    logger,
    idGenerator: () => randomUUID(),
    publishToken: (token) => {
      if (collected.length >= SAMPLE_SIZE) return;
      collected.push(token);
      console.log(`captured ${collected.length}/${SAMPLE_SIZE}: ${token.mint}`);
      if (collected.length >= SAMPLE_SIZE) ctrl.abort();
    },
  });

  console.log(`connecting to PumpPortal, capturing ${SAMPLE_SIZE} fresh mints...`);
  await source.start(ctrl.signal);

  const offsetsLabel = PROBE_OFFSETS_MS.map((ms) => ms / 1000).join('/');
  console.log(`\nprobing RugCheck for top-holder data at +${offsetsLabel}s per mint...\n`);

  const results = await Promise.all(
    collected.map(async (token) => {
      const detectedAtMs = token.detectedAt.getTime();
      for (const offset of PROBE_OFFSETS_MS) {
        const waitMs = detectedAtMs + offset - Date.now();
        if (waitMs > 0) await sleep(waitMs);
        const result = await rugcheck.fetchReport(token.mint, new AbortController().signal);
        const ready = result.kind === 'ok' && result.value.topHolders.length > 0;
        if (ready) return { mint: token.mint, readyAtSec: offset / 1000 };
      }
      return { mint: token.mint, readyAtSec: null };
    }),
  );

  console.log('=== RugCheck readiness (first offset with populated topHolders) ===');
  for (const r of results) {
    console.log(
      `${r.mint}: ${r.readyAtSec === null ? 'not ready within 300s' : `+${r.readyAtSec}s`}`,
    );
  }
  const readyCount = results.filter((r) => r.readyAtSec !== null).length;
  console.log(`\n${readyCount}/${results.length} became queryable within 300s`);
  process.exit(0);
};

await main();
