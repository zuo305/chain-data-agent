import type { Bindings } from "../../types";

// Minimal Solana JSON-RPC client. Responses are kept in the Workers cache so
// bursts of calls (and the free 402 previews) share one upstream request:
// the free endpoints rate limit Cloudflare's shared egress addresses, and
// parsing the full vote account list costs about 2 ms of CPU. A cached
// answer is fresh for RPC_CACHE_SECONDS; when every endpoint refuses, an
// answer up to RPC_STALE_SECONDS old is served instead, and its age is
// reported to the caller. That answer comes from the edge cache of the
// serving location or, failing that, from the snapshot the cron trigger
// stores in D1 every 10 minutes (shared by every location).

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
  const stored = await readStoredAnswer<T>(env, method, params);
  if (stored) return stored;
  throw new RpcUnavailableError(`${method}: ${failures.join("; ")}`);
}

// Snapshot of the calls every endpoint makes, kept in D1 by the cron trigger
const COMMITMENT = { commitment: "confirmed" };
export const SNAPSHOT_CALLS: Array<{ method: string; params: unknown[] }> = [
  { method: "getEpochInfo", params: [COMMITMENT] },
  { method: "getVoteAccounts", params: [COMMITMENT] },
  { method: "getBlockProduction", params: [COMMITMENT] },
];

export const snapshotKey = (method: string, params: unknown[]) => `${method}:${JSON.stringify(params)}`;

async function readStoredAnswer<T>(env: Bindings, method: string, params: unknown[]): Promise<Timed<T> | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT fetched_at, body FROM rpc_snapshot WHERE call_key = ?")
      .bind(snapshotKey(method, params))
      .first<{ fetched_at: number; body: string }>();
    if (!row || Date.now() - row.fetched_at > RPC_STALE_SECONDS * 1000) return null;
    const json = JSON.parse(row.body) as RpcResponse<T>;
    return json.result === undefined ? null : { result: json.result, fetchedAt: row.fetched_at };
  } catch (err) {
    console.error("Reading the stored RPC snapshot failed", err);
    return null;
  }
}

// Cron: stores the current answer of every snapshot call, as raw response
// text (parsing and re-serialising the ~315 KB vote account list would cost
// several ms of the 10 ms CPU budget). A call no endpoint answers keeps its
// previous row. Returns the number of calls stored.
export async function storeSnapshot(env: Bindings): Promise<number> {
  const configured = env.SOLANA_RPC_URL?.trim();
  const endpoints = configured ? [configured, ...FALLBACK_RPC_URLS] : FALLBACK_RPC_URLS;
  const rows: Array<{ key: string; body: string }> = [];
  const missing: string[] = [];
  for (const { method, params } of SNAPSHOT_CALLS) {
    let stored = false;
    for (const url of endpoints) {
      const body = await fetchRawAnswer(url, method, params);
      if (body) {
        rows.push({ key: snapshotKey(method, params), body });
        stored = true;
        break;
      }
    }
    if (!stored) missing.push(method);
  }
  if (missing.length) console.warn(`RPC snapshot: no endpoint answered ${missing.join(", ")}; keeping the previous rows`);
  if (!rows.length) return 0;
  const now = Date.now();
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare("INSERT OR REPLACE INTO rpc_snapshot (call_key, fetched_at, body) VALUES (?, ?, ?)").bind(
        r.key,
        now,
        r.body
      )
    )
  );
  return rows.length;
}

// Response text of a successful call, or null. Checked without parsing: a
// JSON-RPC success carries "result" and no top-level "error" before it.
async function fetchRawAnswer(url: string, method: string, params: unknown[]): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const result = text.indexOf('"result"');
    const error = text.indexOf('"error"');
    return result >= 0 && (error < 0 || error > result) ? text : null;
  } catch {
    return null;
  }
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
  const [epochInfo, voteAccounts, blockProduction] = await Promise.all([
    rpcCallTimed<RawEpochInfo>(env, "getEpochInfo", [COMMITMENT]),
    rpcCallTimed<RawVoteAccounts>(env, "getVoteAccounts", [COMMITMENT]),
    rpcCallTimed<RawBlockProduction>(env, "getBlockProduction", [COMMITMENT]),
  ]);
  return {
    epochInfo: epochInfo.result,
    voteAccounts: voteAccounts.result,
    blockProduction: blockProduction.result,
    fetchedAt: Math.min(epochInfo.fetchedAt, voteAccounts.fetchedAt, blockProduction.fetchedAt),
  };
}
