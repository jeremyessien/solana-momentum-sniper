export type TokenTradeObserved = {
  readonly tokenInternalId: string;
  readonly mint: string;
  readonly trader: string;
  readonly isBuy: boolean;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
  readonly slot: bigint;
  readonly signature: string;
  readonly observedAt: Date;
  readonly pumpFunTimestamp: bigint;
};
