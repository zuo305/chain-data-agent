import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { apiKeyFromHeaders, generateApiKey, hashApiKey } from "../src/platform/apikeys";
import { createTestD1 } from "./helpers/d1";
import { stubSolanaRpc } from "./helpers/solana";

beforeEach(() => {
  stubSolanaRpc();
});
afterEach(() => vi.unstubAllGlobals());

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} } as any;
const ADMIN = { Authorization: "Bearer s3cret" };

async function setup() {
  const db = createTestD1();
  // No X402_PAY_TO: paid endpoints return 503 to callers without a key
  const env = { DB: db, ADMIN_TOKEN: "s3cret" };
  const request = (path: string, init: RequestInit = {}) => app.request(path, init, env, ctx);
  const createKey = async (name = "apify") => {
    const res = await request("/admin/api-keys", { method: "POST", headers: ADMIN, body: JSON.stringify({ name }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { db, request, createKey };
}

const SEARCH = "/v1/solana-validators/validators?limit=5";

describe("API keys", () => {
  it("reads keys from X-API-Key or a prefixed bearer token only", () => {
    expect(apiKeyFromHeaders(undefined, " adp_abc ")).toBe("adp_abc");
    expect(apiKeyFromHeaders("Bearer adp_abc", undefined)).toBe("adp_abc");
    expect(apiKeyFromHeaders("Bearer some-oauth-token", undefined)).toBeNull();
    expect(apiKeyFromHeaders(undefined, undefined)).toBeNull();
  });

  it("generates distinct prefixed keys and stores only their hash", async () => {
    const a = generateApiKey();
    expect(a).toMatch(/^adp_[A-Za-z0-9_-]{43}$/);
    expect(generateApiKey()).not.toBe(a);

    const { db, createKey } = await setup();
    const { status, body } = await createKey();
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 1, name: "apify", key_prefix: body.key.slice(0, 12) });
    const row = db.sqlite.prepare("SELECT key_hash FROM api_keys").get() as { key_hash: string };
    expect(row.key_hash).toBe(await hashApiKey(body.key));
    expect(JSON.stringify(db.sqlite.prepare("SELECT * FROM api_keys").all())).not.toContain(body.key);
  });

  it("serves paid endpoints without x402 for a valid key and logs the key", async () => {
    const { db, request, createKey } = await setup();
    expect((await request(SEARCH)).status).toBe(503);

    const { body } = await createKey();
    const variants: Record<string, string>[] = [{ "X-API-Key": body.key }, { Authorization: `Bearer ${body.key}` }];
    for (const headers of variants) {
      const res = await request(SEARCH, { headers });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).data.length).toBeGreaterThan(0);
    }

    await Promise.all(pending);
    const rows = db.sqlite.prepare("SELECT tier, api_key_id FROM usage_log WHERE path = ? AND status = 200").all(SEARCH.split("?")[0]);
    expect(rows).toEqual([
      { tier: "api_key", api_key_id: body.id },
      { tier: "api_key", api_key_id: body.id },
    ]);
  });

  it("serves paid MCP tools for a valid key", async () => {
    const { request, createKey } = await setup();
    const { body } = await createKey();
    const res = await request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-API-Key": body.key },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "solana_validators_list_validators", arguments: { limit: "5" } },
      }),
    });
    const { result } = (await res.json()) as any;
    expect(result.isError).toBe(false);
    expect(result.structuredContent.data.length).toBeGreaterThan(0);
  });

  it("rejects unknown and revoked keys", async () => {
    const { request, createKey } = await setup();
    const unknown = await request(SEARCH, { headers: { "X-API-Key": "adp_unknown" } });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as any).error).toBe("invalid_api_key");

    const { body } = await createKey();
    const revoke = await request(`/admin/api-keys/${body.id}/revoke`, { method: "POST", headers: ADMIN });
    expect(await revoke.json()).toEqual({ id: body.id, revoked: true });
    expect((await request(SEARCH, { headers: { "X-API-Key": body.key } })).status).toBe(401);
    expect((await request(`/admin/api-keys/${body.id}/revoke`, { method: "POST", headers: ADMIN })).status).toBe(404);
  });

  it("lists keys without secrets and validates admin input", async () => {
    const { request, createKey } = await setup();
    expect((await createKey("")).status).toBe(400);
    const { body } = await createKey("apify");
    const list = (await (await request("/admin/api-keys", { headers: ADMIN })).json()) as any;
    expect(list.api_keys).toEqual([
      { id: body.id, name: "apify", key_prefix: body.key_prefix, created_at: body.created_at, revoked_at: null },
    ]);
    expect((await request("/admin/api-keys", { method: "POST", body: "{}" })).status).toBe(401);
  });
});
