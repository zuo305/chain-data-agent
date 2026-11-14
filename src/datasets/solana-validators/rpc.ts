import type { Bindings } from "../../types";

// Minimal Solana JSON-RPC client. Responses are kept in the Workers cache so
// bursts of calls (and the free 402 previews) share one upstream request:
// the free endpoints rate limit Cloudflare's shared egress addresses, and
// parsing the full vote account list costs about 2 ms of CPU. A cached
// answer is fresh for RPC_CACHE_SECONDS; when every endpoint refuses, an
// answer up to RPC_STALE_SECONDS old is served instead, and its age is
// reported to the caller.

export const PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";
// Free endpoints without an API key, tried in order after SOLANA_RPC_URL.
// Each may block or rate limit Cloudflare's egress addresses, so a failure
// moves on to the next one.
export const FALLBACK_RPC_URLS = [PUBLIC_RPC_URL, "https://solana-rpc.publicnode.com"];
export const RPC_CACHE_SECONDS = 60;
export const RPC_STALE_SECONDS = 3_600;
const RPC_TIMEOUT_MS = 8_000;

export class RpcUnavailableError extends Error {}

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } };

export type Timed<T> = { result: T; fetchedAt: number };

export async function rpcCall<T>(env: Bindings, method: string, params: unknown[] = []): Promise<T> {
  return (await rpcCallTimed<T>(env, method, params)).result;
}

// Result with the time it was fetched (ms since epoch), from the cache when fresh
export async function rpcCallTimed<T>(env: Bindings, method: string, params: unknown[] = []): Promise<Timed<T>> {
  const cache = workersCache();
  // Synthetic GET key: the Cache API only stores GET requests. The RPC URL
  // is not part of the key, so a configured API key never reaches the cache.
  const key = new Request(`https://solana-rpc.cache/${method}?p=${encodeURIComponent(JSON.stringify(params))}`);
  let cached: Timed<T> | undefined;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) cached = (await hit.json()) as Timed<T>;
    if (cached && Date.now() - cached.fetchedAt < RPC_CACHE_SECONDS * 1000) return cached;
  }

  const configured = env.SOLANA_RPC_URL?.trim();
  const endpoints = configured ? [configured, ...FALLBACK_RPC_URLS] : FALLBACK_RPC_URLS;
  const failures: string[] = [];
  for (const url of endpoints) {
    try {
      const fresh: Timed<T> = { result: await callEndpoint<T>(url, method, params), fetchedAt: Date.now() };
      if (cache) {
        const stored = new Response(JSON.stringify(fresh), {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${RPC_STALE_SECONDS}` },
        });
        await cache.put(key, stored).catch(() => undefined);
      }
      return fresh;
    } catch (err) {
      if (!(err instanceof RpcUnavailableError)) throw err;
      // A configured URL may embed an API key: never name it
      const label = url === configured ? "configured endpoint" : new URL(url).host;
      failures.push(`${label} ${err.message}`);
    }
  }
  if (cached) return cached;
  throw new RpcUnavailableError(`${method}: ${failures.join("; ")}`);
}

async function callEndpoint<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RpcUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new RpcUnavailableError(`HTTP ${res.status}`);
  let json: RpcResponse<T>;
  try {
    json = (await res.json()) as RpcResponse<T>;
  } catch {
    throw new RpcUnavailableError("response is not JSON");
  }
  if (json.error || json.result === undefined) {
    throw new RpcUnavailableError(json.error?.message ?? "empty result");
  }
  return json.result;
}

// caches.default exists only in the Workers runtime (not in unit tests)
function workersCache(): Cache | undefined {
  const c = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  return c?.default;
}

// Raw RPC shapes (only the fields used)

export type RawVoteAccount = {
  votePubkey: string;
  nodePubkey: string;
  activatedStake: number;
  commission: number;
  epochVoteAccount: boolean;
  // [epoch, credits at end of epoch, credits at start of epoch]
  epochCredits: Array<[number, number, number]>;
  lastVote: number;
  rootSlot: number;
  inflationRewardsCommissionBps?: number;
};

export type RawVoteAccounts = { current: RawVoteAccount[]; delinquent: RawVoteAccount[] };

export type RawEpochInfo = {
  absoluteSlot: number;
  blockHeight: number;
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  transactionCount?: number;
};

export type RawBlockProduction = {
  context: { slot: number };
  value: {
    // identity -> [leader slots, blocks produced]
    byIdentity: Record<string, [number, number]>;
    range: { firstSlot: number; lastSlot: number };
  };
};

export type ChainSnapshot = {
  epochInfo: RawEpochInfo;
  voteAccounts: RawVoteAccounts;
  blockProduction: RawBlockProduction;
  // When the oldest of the three answers was fetched (ms since epoch)
  fetchedAt?: number;
};

export async function fetchSnapshot(env: Bindings): Promise<ChainSnapshot> {
  const commitment = { commitment: "confirmed" };
  const [epochInfo, voteAccounts, blockProduction] = await Promise.all([
    rpcCallTimed<RawEpochInfo>(env, "getEpochInfo", [commitment]),
    rpcCallTimed<RawVoteAccounts>(env, "getVoteAccounts", [commitment]),
    rpcCallTimed<RawBlockProduction>(env, "getBlockProduction", [commitment]),
  ]);
  return {
    epochInfo: epochInfo.result,
    voteAccounts: voteAccounts.result,
    blockProduction: blockProduction.result,
    fetchedAt: Math.min(epochInfo.fetchedAt, voteAccounts.fetchedAt, blockProduction.fetchedAt),
  };
}
