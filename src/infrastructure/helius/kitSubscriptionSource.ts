import { address, createSolanaRpcSubscriptions } from '@solana/kit';
import type { ProgramLogEvent } from '../../shared/programLogEvent.js';
import type { SubscriptionSource } from './heliusAdapter.js';

type KitLogsNotification = {
  context: { slot: bigint };
  value: {
    signature: string;
    logs: readonly string[];
    err: unknown | null;
  };
};

export const transformLogsNotification = (n: KitLogsNotification): ProgramLogEvent => ({
  signature: n.value.signature,
  slot: n.context.slot,
  logs: n.value.logs,
  err: n.value.err,
});

export const createKitSubscriptionSource = (wsUrl: string): SubscriptionSource => {
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  return {
    streamLogs: async function* (programId, commitment, signal) {
      const subscription = await rpcSubscriptions
        .logsNotifications({ mentions: [address(programId)] }, { commitment })
        .subscribe({ abortSignal: signal });
      for await (const notification of subscription) {
        yield transformLogsNotification(notification);
      }
    },
  };
};
