import type { Bindings } from "../../types";
import { PUBLIC_RPC_URL } from "../solana-validators/rpc";

// SOL stake accounts whose lockup has not expired yet. A lockup stops the
// withdraw authority from withdrawing (or the staker from re-delegating to a
// new authority) before lockup.unix_timestamp; the custodian can lift it
// early. The hourly cron reads them with getProgramAccounts and stores one
// parsed snapshot row in D1; requests only read that row.

export const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
export const LOCKUPS_KEY = "sol-stake-lockups:v1";
// Rows older than this are not served (lockups change slowly; the cron
// refreshes hourly, so this only matters when the RPC refuses for days)
export const LOCKUPS_MAX_AGE_SECONDS = 7 * 86_400;

// StakeStateV2 (200 bytes): state u32 @0, rent_exempt_reserve u64 @4,
// staker @12, withdrawer @44, lockup.unix_timestamp i64 @76, lockup.epoch
// u64 @84, lockup.custodian @92, delegation.voter_pubkey @124 (state 2).
// The slice stops after the voter; lamports come with the account.
const SLICE = { offset: 0, length: 156 };
// getProgramAccounts cannot filter a range, so accounts are fetched per
// value of the timestamp's 4th byte (~194 days each), with the high bytes
// zero: from the window holding "now" through LOOKAHEAD_WINDOWS more (~4.8
// years). No mainnet lockup was set past mid-2028 as of 2026-11.
const LOOKAHEAD_WINDOWS = 8;
const RPC_TIMEOUT_MS = 60_000;

// Stored per account: [stake account, lamports, unlocks_at (unix s),
// withdrawer, custodian, voter or ""] with keys as base64 of the raw 32 bytes
// (base58 encoding is done only for the rows a response returns)
export type StoredLockup = [string, number, number, string, string, string];
export type LockupSnapshot = { refreshedAt: number; lockups: StoredLockup[] };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function decodeBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type ProgramAccount = { pubkey: string; account: { lamports: number; data: [string, string] } };

// Accounts whose lockup timestamp has `window` as its 4th byte
async function fetchWindow(url: string, window: number): Promise<ProgramAccount[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getProgramAccounts",
      params: [
        STAKE_PROGRAM,
        {
          encoding: "base64",
          dataSlice: SLICE,
          filters: [
            { dataSize: 200 },
            { memcmp: { offset: 79, bytes: b64(new Uint8Array([window])), encoding: "base64" } },
            { memcmp: { offset: 80, bytes: b64(new Uint8Array(4)), encoding: "base64" } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { result?: ProgramAccount[]; error?: { message: string } };
  if (!json.result) throw new Error(json.error?.message ?? "empty result");
  return json.result;
}

export function parseLockup(account: ProgramAccount, now: number): StoredLockup | null {
  const data = decodeBase64(account.account.data[0]);
  if (data.length < SLICE.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const state = view.getUint32(0, true);
  const unlocksAt = Number(view.getBigInt64(76, true));
  if (unlocksAt <= now) return null;
  return [
    account.pubkey,
    account.account.lamports,
    unlocksAt,
    b64(data.subarray(44, 76)),
    b64(data.subarray(92, 124)),
    state === 2 ? b64(data.subarray(124, 156)) : "",
  ];
}

// Cron: refreshes the snapshot row. Any failed window aborts the refresh so a
// partial list never replaces a complete one. Returns the number of lockups.
export async function refreshLockups(env: Bindings): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const first = Math.floor(now / 2 ** 24) & 0xff;
  // publicnode.com refuses getProgramAccounts without a personal token
  const endpoints = [env.SOLANA_RPC_URL?.trim(), PUBLIC_RPC_URL].filter((u): u is string => Boolean(u));
  let accounts: ProgramAccount[] | null = null;
  const failures: string[] = [];
  for (const url of endpoints) {
    try {
      const all: ProgramAccount[] = [];
      for (let w = first; w <= first + LOOKAHEAD_WINDOWS; w++) all.push(...(await fetchWindow(url, w)));
      accounts = all;
      break;
    } catch (err) {
      failures.push(`${url === endpoints[0] && env.SOLANA_RPC_URL ? "configured endpoint" : new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!accounts) {
    console.warn(`SOL lockups: refresh failed (${failures.join("; ")}); keeping the previous snapshot`);
    return 0;
  }
  const lockups = accounts.map((a) => parseLockup(a, now)).filter((l): l is StoredLockup => l !== null);
  const snapshot: LockupSnapshot = { refreshedAt: Date.now(), lockups };
  await env.DB.prepare("INSERT OR REPLACE INTO rpc_snapshot (call_key, fetched_at, body) VALUES (?, ?, ?)")
    .bind(LOCKUPS_KEY, snapshot.refreshedAt, JSON.stringify(snapshot))
    .run();
  return lockups.length;
}

// Parsed snapshot per isolate, reloaded when the stored row changes
let memo: { fetchedAt: number; snapshot: LockupSnapshot } | null = null;

export async function loadLockups(env: Bindings): Promise<LockupSnapshot | null> {
  const meta = await env.DB.prepare("SELECT fetched_at FROM rpc_snapshot WHERE call_key = ?")
    .bind(LOCKUPS_KEY)
    .first<{ fetched_at: number }>();
  if (!meta || Date.now() - meta.fetched_at > LOCKUPS_MAX_AGE_SECONDS * 1000) return null;
  if (memo?.fetchedAt === meta.fetched_at) return memo.snapshot;
  const row = await env.DB.prepare("SELECT body FROM rpc_snapshot WHERE call_key = ?")
    .bind(LOCKUPS_KEY)
    .first<{ body: string }>();
  if (!row) return null;
  memo = { fetchedAt: meta.fetched_at, snapshot: JSON.parse(row.body) as LockupSnapshot };
  return memo.snapshot;
}

// Base58 for 32-byte keys (only for the rows a response returns)
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Divides by 58^9 per step (BigInt; 58^9 < 2^53, so each chunk is an exact
// Number), faster than the byte-by-byte algorithm for 32-byte keys
const CHUNK = 58n ** 9n;

export function base58(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  let n = BigInt(`0x${hex || "0"}`);
  let out = "";
  while (n > 0n) {
    let r = Number(n % CHUNK);
    n /= CHUNK;
    for (let i = 0; i < 9; i++) {
      out = ALPHABET[r % 58] + out;
      r = Math.floor(r / 58);
      if (n === 0n && r === 0) break;
    }
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function decodeBase58(text: string): Uint8Array | null {
  let n = 0n;
  for (const ch of text) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) return null;
    n = n * 58n + BigInt(value);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

// Encoded keys per isolate: the same authorities and custodians recur
const encoded = new Map<string, string>();

export function keyFromB64(value: string): string | null {
  if (!value) return null;
  let key = encoded.get(value);
  if (key === undefined) {
    key = base58(decodeBase64(value));
    if (encoded.size < 5_000) encoded.set(value, key);
  }
  return key;
}

// base64 of a base58 key, for comparing with stored keys; null if invalid
export function keyToB64(key: string): string | null {
  const bytes = decodeBase58(key);
  return bytes && bytes.length === 32 ? b64(bytes) : null;
}
