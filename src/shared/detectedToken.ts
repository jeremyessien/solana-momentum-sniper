/**
 * Identifier for the launchpad a token was detected on. Currently only
 * Pump.fun is monitored; new launchpads are added here as detection
 * support for them lands.
 */
export type Launchpad = 'pumpfun';

/**
 * A token at the moment of detection. Carries only the information
 * available from the launch event itself — no holder counts, transaction
 * patterns, or other enrichment. Those land on `TokenWithFullContext`
 * after the enrichment layer runs.
 *
 * Liquidity is stored as a `bigint` lamport count, never as a SOL float,
 * per Engineering Standards Principle Twelve and the codebase-wide
 * convention that all chain-native amounts are bigints. Convert to SOL
 * for display only, never for arithmetic.
 */
export type DetectedToken = {
  readonly internalId: string;
  readonly mint: string;
  readonly launchpad: Launchpad;
  readonly creatorWallet: string;
  readonly initialLiquidityLamports: bigint;
  readonly detectedAt: Date;
};
