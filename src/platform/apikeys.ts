// API keys let a partner (e.g. an Apify Actor that bills its own users) call
// paid endpoints without paying per request via x402. Keys look like
// "adp_<43 base64url chars>"; only their SHA-256 hash is stored.

export const API_KEY_PREFIX = "adp_";
// Characters of the key kept in clear text to tell keys apart in lists
const DISPLAY_PREFIX_LENGTH = 12;

export type ApiKeyRecord = { id: number; name: string };

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateApiKey(): string {
  return API_KEY_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// The API key a request carries, if any. Bearer tokens without our prefix
// (the admin token, OAuth tokens some MCP clients send) are not API keys.
export function apiKeyFromHeaders(authorization: string | undefined, xApiKey: string | undefined): string | null {
  const header = xApiKey?.trim();
  if (header) return header;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return bearer.startsWith(API_KEY_PREFIX) ? bearer : null;
}

export async function findApiKey(db: D1Database, key: string): Promise<ApiKeyRecord | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  return db
    .prepare("SELECT id, name FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await hashApiKey(key))
    .first<ApiKeyRecord>();
}

export async function createApiKey(db: D1Database, name: string) {
  const key = generateApiKey();
  const row = await db
    .prepare("INSERT INTO api_keys (name, key_hash, key_prefix) VALUES (?, ?, ?) RETURNING id, name, key_prefix, created_at")
    .bind(name, await hashApiKey(key), key.slice(0, DISPLAY_PREFIX_LENGTH))
    .first<{ id: number; name: string; key_prefix: string; created_at: string }>();
  return { ...row!, key };
}

export async function listApiKeys(db: D1Database) {
  const { results } = await db
    .prepare("SELECT id, name, key_prefix, created_at, revoked_at FROM api_keys ORDER BY id")
    .all<Record<string, unknown>>();
  return results;
}

export async function revokeApiKey(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    .bind(id)
    .run();
  return (res.meta.changes ?? res.meta.rows_written ?? 0) > 0;
}
