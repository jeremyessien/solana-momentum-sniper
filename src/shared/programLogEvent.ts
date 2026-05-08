export type Commitment = 'processed' | 'confirmed' | 'finalized';

export type ProgramLogEvent = {
  readonly signature: string;
  readonly slot: bigint;
  readonly logs: readonly string[];
  readonly err: unknown | null;
};
