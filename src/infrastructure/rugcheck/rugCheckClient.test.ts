import { describe, expect, test, vi } from 'vitest';
import type { Clock } from '../clock/clock.js';
import { createRugCheckClient } from './rugCheckClient.js';

const FIXED_DATE = new Date('2026-05-11T12:00:00Z');

const makeClock = (): Clock => ({
  now: () => FIXED_DATE,
  monotonicMs: () => 0,
  sleep: () => Promise.resolve(),
});

const VALID_RESPONSE_BODY = JSON.stringify({
  mint: 'TestMint1234',
  tokenProgram: 'TokenProgram',
  creator: 'CreatorWallet',
  creatorBalance: 1_000_000_000,
  token: {
    mintAuthority: null,
    supply: 1_000_000_000_000,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: null,
  },
  tokenMeta: { name: 'Test Token', symbol: 'TEST' },
  topHolders: [
    {
      address: 'Holder1',
      owner: 'Owner1',
      amount: 500_000_000,
      decimals: 6,
      pct: 50.0,
      insider: false,
    },
    {
      address: 'Holder2',
      owner: 'Owner2',
      amount: 100_000_000,
      decimals: 6,
      pct: 10.0,
      insider: true,
    },
  ],
  mintAuthority: null,
  freezeAuthority: null,
  risks: [],
  score: 1,
  score_normalised: 1,
  rugged: false,
  totalMarketLiquidity: 50_000.0,
  totalHolders: 250,
});

describe('createRugCheckClient', () => {
  test('returns ok with parsed snapshot on a valid 200 response', async () => {
    const ctrl = new AbortController();
    const client = createRugCheckClient({
      clock: makeClock(),
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response(VALID_RESPONSE_BODY, { status: 200 })) as never,
    });

    const result = await client.fetchReport('SomeMint', ctrl.signal);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const snap = result.value;
    expect(snap.mint).toBe('TestMint1234');
    expect(snap.scoreNormalised).toBe(1);
    expect(snap.creatorBalance).toBe(1_000_000_000n);
    expect(typeof snap.creatorBalance).toBe('bigint');
    expect(snap.topHolders).toHaveLength(2);
    expect(snap.topHolders[0]?.amount).toBe(500_000_000n);
    expect(typeof snap.topHolders[0]?.amount).toBe('bigint');
    expect(snap.tokenName).toBe('Test Token');
    expect(snap.tokenSymbol).toBe('TEST');
    expect(snap.snapshotAt).toBe(FIXED_DATE);
    expect(snap.rawJson).toBe(VALID_RESPONSE_BODY);
    expect(snap.totalMarketLiquidityUsd).toBe(50_000.0);
    expect(snap.totalHolders).toBe(250);
  });

  test('returns http_error on non-2xx status', async () => {
    const ctrl = new AbortController();
    const client = createRugCheckClient({
      clock: makeClock(),
      fetchImpl: vi.fn().mockResolvedValue(new Response('not found', { status: 404 })) as never,
    });

    const result = await client.fetchReport('SomeMint', ctrl.signal);

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('http_error');
    if (result.error.kind !== 'http_error') return;
    expect(result.error.status).toBe(404);
  });

  test('returns schema_invalid on malformed JSON', async () => {
    const ctrl = new AbortController();
    const client = createRugCheckClient({
      clock: makeClock(),
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response('not json at all', { status: 200 })) as never,
    });

    const result = await client.fetchReport('SomeMint', ctrl.signal);

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('schema_invalid');
  });

  test('returns schema_invalid when required fields are missing', async () => {
    const ctrl = new AbortController();
    const client = createRugCheckClient({
      clock: makeClock(),
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response('{"unrelated":"shape"}', { status: 200 })) as never,
    });

    const result = await client.fetchReport('SomeMint', ctrl.signal);

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('schema_invalid');
  });

  test('returns network_error when fetch throws', async () => {
    const ctrl = new AbortController();
    const client = createRugCheckClient({
      clock: makeClock(),
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('connect ECONNREFUSED')) as never,
    });

    const result = await client.fetchReport('SomeMint', ctrl.signal);

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('network_error');
  });

  test('returns timeout when the fetch exceeds the configured timeout', async () => {
    const ctrl = new AbortController();
    const slowFetch: typeof fetch = vi.fn().mockImplementation(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal === undefined) return;
          signal.addEventListener(
            'abort',
            () => {
              const reason = signal.reason;
              if (reason instanceof Error) reject(reason);
              else reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );

    const client = createRugCheckClient({
      clock: makeClock(),
      timeoutMs: 30,
      fetchImpl: slowFetch,
    });

    const result = await client.fetchReport('SomeMint', ctrl.signal);

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('timeout');
  });

  test('returns network_error and does not call fetch when parent signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchSpy = vi.fn();
    const client = createRugCheckClient({
      clock: makeClock(),
      fetchImpl: fetchSpy as never,
    });

    const result = await client.fetchReport('SomeMint', ctrl.signal);

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('network_error');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('aborts in-flight fetch when parent signal aborts mid-call', async () => {
    const ctrl = new AbortController();
    const slowFetch: typeof fetch = vi.fn().mockImplementation(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal === undefined) return;
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );

    const client = createRugCheckClient({
      clock: makeClock(),
      fetchImpl: slowFetch,
    });

    const promise = client.fetchReport('SomeMint', ctrl.signal);
    ctrl.abort();
    const result = await promise;

    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('network_error');
  });
});
