export type RugCheckRiskFlag = {
  readonly name: string;
  readonly level: string;
  readonly score: number;
  readonly description: string;
};

export type RugCheckHolder = {
  readonly address: string;
  readonly owner: string;
  readonly amount: bigint;
  readonly pct: number;
  readonly insider: boolean;
};

export type RugCheckSnapshot = {
  readonly snapshotAt: Date;
  readonly mint: string;
  readonly score: number;
  readonly scoreNormalised: number;
  readonly risks: readonly RugCheckRiskFlag[];
  readonly rugged: boolean;
  readonly creatorBalance: bigint;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly topHolders: readonly RugCheckHolder[];
  readonly totalHolders: number;
  readonly totalMarketLiquidityUsd: number;
  readonly tokenName: string | null;
  readonly tokenSymbol: string | null;
  readonly rawJson: string;
};

export type RugCheckFetchError =
  | { readonly kind: 'timeout' }
  | { readonly kind: 'http_error'; readonly status: number }
  | { readonly kind: 'schema_invalid'; readonly details: string }
  | { readonly kind: 'network_error'; readonly message: string };
