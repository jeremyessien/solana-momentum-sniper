import type { Clock } from '../infrastructure/clock/clock.js';
import type { Logger } from '../infrastructure/logger/logger.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import type { ProgramLogEvent } from '../shared/programLogEvent.js';
import { parsePumpfunCreate } from './pumpfunCreateParser.js';

export type SubscribeToRawLogs = (handler: (event: ProgramLogEvent) => void) => () => void;

export type PublishToken = (token: DetectedToken) => void;

export type IdGenerator = () => string;

export type WireDetectionDeps = {
  readonly subscribeToRawLogs: SubscribeToRawLogs;
  readonly publishToken: PublishToken;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly idGenerator: IdGenerator;
  readonly signal: AbortSignal;
};

export const wireDetection = (deps: WireDetectionDeps): void => {
  if (deps.signal.aborted) return;

  const handler = (event: ProgramLogEvent): void => {
    const token = parsePumpfunCreate(event, {
      internalId: deps.idGenerator(),
      detectedAt: deps.clock.now(),
    });
    if (token === null) return;

    deps.logger.info(
      {
        launchpad: token.launchpad,
        mint: token.mint,
        creatorWallet: token.creatorWallet,
        initialLiquidityLamports: token.initialLiquidityLamports.toString(),
        internalId: token.internalId,
        signature: event.signature,
        slot: event.slot.toString(),
      },
      'new token launch detected',
    );

    deps.publishToken(token);
  };

  const unsubscribe = deps.subscribeToRawLogs(handler);
  deps.signal.addEventListener('abort', unsubscribe, { once: true });
};
