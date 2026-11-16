import type { Bindings } from "../../types";
import { PUBLIC_RPC_URL } from "../solana-validators/rpc";

// SOL stake accounts whose lockup has not expired yet. A lockup stops the
// withdraw authority from withdrawing before lockup.unix_timestamp; the
// custodian can lift it early. mainnet-beta refuses getProgramAccounts from
// Cloudflare, so an hourly GitHub Actions workflow (scripts/refresh-lockups.ts)
// collects them and pushes the parsed list to the Worker, which stores it as
// one D1 row; requests only read that row.

export const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
export const LOCKUPS_KEY = "sol-stake-lockups:v1";
// Rows older than this are not served (lockups change slowly; the workflow
// refreshes hourly, so this only matters when it fails for days)
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

// All pending lockups from one endpoint; throws if any window fails, so a
// partial list never replaces a complete one
export async function collectLockups(url: string, now: number): Promise<StoredLockup[]> {
  const first = Math.floor(now / 2 ** 24) & 0xff;
  const accounts: ProgramAccount[] = [];
  for (let w = first; w <= first + LOOKAHEAD_WINDOWS; w++) accounts.push(...(await fetchWindow(url, w)));
  return accounts.map((a) => parseLockup(a, now)).filter((l): l is StoredLockup => l !== null);
}

export async function storeLockups(env: Bindings, snapshot: LockupSnapshot): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO rpc_snapshot (call_key, fetched_at, body) VALUES (?, ?, ?)")
    .bind(LOCKUPS_KEY, snapshot.refreshedAt, JSON.stringify(snapshot))
    .run();
}

const B64_KEY = /^[A-Za-z0-9+/]{43}=$/;
const MAX_LOCKUPS = 50_000;

// A pushed snapshot in the stored shape, or the reason it is not
export function validateSnapshot(body: unknown, nowMs = Date.now()): LockupSnapshot | string {
  if (!body || typeof body !== "object") return "body must be an object";
  const { refreshedAt, lockups } = body as Record<string, unknown>;
  if (typeof refreshedAt !== "number" || refreshedAt > nowMs + 300_000 || refreshedAt < nowMs - 86_400_000) {
    return "refreshedAt must be a recent time in ms";
  }
  if (!Array.isArray(lockups) || lockups.length > MAX_LOCKUPS) return `lockups must be an array of at most ${MAX_LOCKUPS}`;
  for (const l of lockups) {
    if (
      !Array.isArray(l) ||
      l.length !== 6 ||
      typeof l[0] !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(l[0]) ||
      !Number.isSafeInteger(l[1]) ||
      l[1] < 0 ||
      !Number.isSafeInteger(l[2]) ||
      !B64_KEY.test(l[3]) ||
      !B64_KEY.test(l[4]) ||
      (l[5] !== "" && !B64_KEY.test(l[5]))
    ) {
      return "each lockup must be [stake account, lamports, unlocks_at, withdrawer, custodian, voter or \"\"]";
    }
  }
  return { refreshedAt, lockups: lockups as StoredLockup[] };
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
