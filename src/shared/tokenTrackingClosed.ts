export type TokenTrackingCloseReason = 'graduated' | 'timeout';

export type TokenTrackingClosed = {
  readonly tokenInternalId: string;
  readonly mint: string;
  readonly closedAt: Date;
  readonly reason: TokenTrackingCloseReason;
  readonly tradeCount: number;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly uniqueTraders: number;
  readonly creatorTraded: boolean;
  readonly firstTradeSlot: bigint | null;
  readonly lastTradeSlot: bigint | null;
};
