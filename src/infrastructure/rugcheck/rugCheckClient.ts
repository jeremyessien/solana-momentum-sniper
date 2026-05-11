import { z } from 'zod';
import { RUGCHECK_API_BASE_URL } from '../../shared/externalApis.js';
import { err, ok, type Result } from '../../shared/result.js';
import type {
  RugCheckFetchError,
  RugCheckHolder,
  RugCheckRiskFlag,
  RugCheckSnapshot,
} from '../../shared/rugCheckSnapshot.js';
import type { Clock } from '../clock/clock.js';

const DEFAULT_TIMEOUT_MS = 3_000;

const riskSchema = z.looseObject({
  name: z.string(),
  level: z.string(),
  score: z.number(),
  description: z.string(),
});

const holderSchema = z.looseObject({
  address: z.string(),
  owner: z.string(),
  amount: z.number(),
  pct: z.number(),
  insider: z.boolean(),
});

const tokenMetaSchema = z.looseObject({
  name: z.string().nullable().optional(),
  symbol: z.string().nullable().optional(),
});

const reportSchema = z.looseObject({
  mint: z.string(),
  score: z.number(),
  score_normalised: z.number(),
  risks: z.array(riskSchema),
  rugged: z.boolean(),
  creatorBalance: z.number(),
  mintAuthority: z.string().nullable(),
  freezeAuthority: z.string().nullable(),
  topHolders: z.array(holderSchema),
  totalHolders: z.number(),
  totalMarketLiquidity: z.number(),
  tokenMeta: tokenMetaSchema.nullable().optional(),
});

export type RugCheckClient = {
  readonly fetchReport: (
    mint: string,
    signal: AbortSignal,
  ) => Promise<Result<RugCheckSnapshot, RugCheckFetchError>>;
};

export type RugCheckClientConfig = {
  readonly clock: Clock;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
};

const toBigInt = (n: number): bigint => {
  if (!Number.isFinite(n)) return 0n;
  if (Number.isInteger(n)) return BigInt(n);
  return BigInt(Math.round(n));
};

export const createRugCheckClient = (config: RugCheckClientConfig): RugCheckClient => {
  const baseUrl = config.baseUrl ?? RUGCHECK_API_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? fetch;

  const fetchReport = async (
    mint: string,
    parentSignal: AbortSignal,
  ): Promise<Result<RugCheckSnapshot, RugCheckFetchError>> => {
    if (parentSignal.aborted) {
      return err({ kind: 'network_error', message: 'parent signal already aborted' });
    }

    const ctrl = new AbortController();
    const timeoutHandle = setTimeout(() => {
      ctrl.abort(new DOMException('timeout', 'TimeoutError'));
    }, timeoutMs);
    const onParentAbort = (): void => {
      ctrl.abort();
    };
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timeoutHandle);
      parentSignal.removeEventListener('abort', onParentAbort);
    };

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/tokens/${mint}/report`, { signal: ctrl.signal });
    } catch (e) {
      cleanup();
      if (parentSignal.aborted) {
        return err({ kind: 'network_error', message: 'parent signal aborted' });
      }
      const reason = ctrl.signal.reason;
      if (reason instanceof DOMException && reason.name === 'TimeoutError') {
        return err({ kind: 'timeout' });
      }
      const message = e instanceof Error ? e.message : String(e);
      return err({ kind: 'network_error', message });
    }
    cleanup();

    if (!response.ok) {
      return err({ kind: 'http_error', status: response.status });
    }

    let rawJson: string;
    try {
      rawJson = await response.text();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err({ kind: 'network_error', message });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawJson);
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e);
      return err({ kind: 'schema_invalid', details: `JSON parse failed: ${details}` });
    }

    const parseResult = reportSchema.safeParse(parsedJson);
    if (!parseResult.success) {
      return err({ kind: 'schema_invalid', details: parseResult.error.message });
    }

    const data = parseResult.data;
    const snapshot: RugCheckSnapshot = {
      snapshotAt: config.clock.now(),
      mint: data.mint,
      score: data.score,
      scoreNormalised: data.score_normalised,
      risks: data.risks.map(
        (r): RugCheckRiskFlag => ({
          name: r.name,
          level: r.level,
          score: r.score,
          description: r.description,
        }),
      ),
      rugged: data.rugged,
      creatorBalance: toBigInt(data.creatorBalance),
      mintAuthority: data.mintAuthority,
      freezeAuthority: data.freezeAuthority,
      topHolders: data.topHolders.map(
        (h): RugCheckHolder => ({
          address: h.address,
          owner: h.owner,
          amount: toBigInt(h.amount),
          pct: h.pct,
          insider: h.insider,
        }),
      ),
      totalHolders: data.totalHolders,
      totalMarketLiquidityUsd: data.totalMarketLiquidity,
      tokenName: data.tokenMeta?.name ?? null,
      tokenSymbol: data.tokenMeta?.symbol ?? null,
      rawJson,
    };

    return ok(snapshot);
  };

  return { fetchReport };
};
