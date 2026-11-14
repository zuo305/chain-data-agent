import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { describeMcpCall } from "../src/platform/mcp";
import { firstIdSince } from "../src/platform/admin";
import { createTestD1 } from "./helpers/d1";

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} } as any;

describe("usage logging", () => {
  it("counts a client that names itself as a probe in initialize as a bot", async () => {
    const db = createTestD1();
    const init = (name: string) =>
      app.request(
        "/mcp",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": "node" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } },
          }),
        },
        { DB: db },
        ctx
      );
    await init("talaria-catalog");
    await init("my-agent");
    await Promise.all(pending);
    const rows = db.sqlite.prepare("SELECT detail, caller_type FROM usage_log ORDER BY id").all() as any[];
    expect(rows).toEqual([
      { detail: "initialize talaria-catalog/1", caller_type: "bot" },
      { detail: "initialize my-agent/1", caller_type: "agent" },
    ]);
  });

  it("records why a request failed with a 5xx", async () => {
    const db = createTestD1();
    // An unexpected failure inside the handler (here a fetch that throws a non-network error)
    vi.stubGlobal("fetch", () => {
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.request("/v1/solana-validators/summary", { headers: { "User-Agent": "node" } }, { DB: db }, ctx);
      // fetch errors count as an unreachable upstream: 503, cause in the log
      expect(res.status).toBe(503);
      await Promise.all(pending);
      const row = db.sqlite.prepare("SELECT status, detail FROM usage_log WHERE path = '/v1/solana-validators/summary'").get() as any;
      expect(row.status).toBe(503);
      expect(row.detail).toContain("[upstream] getEpochInfo: api.mainnet-beta.solana.com boom; solana-rpc.publicnode.com boom");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("records why a request failed with a 500", async () => {
    const db = createTestD1();
    // The RPC answers with an unexpected shape, so the handler throws
    vi.stubGlobal("fetch", async () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.request("/v1/solana-validators/summary", { headers: { "User-Agent": "node" } }, { DB: db }, ctx);
      expect(res.status).toBe(500);
      await Promise.all(pending);
      const row = db.sqlite.prepare("SELECT status, detail FROM usage_log WHERE path = '/v1/solana-validators/summary'").get() as any;
      expect(row.status).toBe(500);
      expect(row.detail).toMatch(/^\[error\] TypeError: /);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("records the user agent and the MCP tool called", async () => {
    const db = createTestD1();
    await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "User-Agent": "TestAgent/1.0",
          "CF-Connecting-IP": "203.0.113.7",
          Referer: "https://news.ycombinator.com/item?id=1",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_data", arguments: { request: "token unlock schedules" } } }),
      },
      { DB: db, CLIENT_ID_SECRET: "k" },
      ctx
    );
    await Promise.all(pending);
    const row = db.sqlite.prepare("SELECT path, status, user_agent, detail, caller_type, referer_host, client_id FROM usage_log").get() as any;
    expect(row.client_id).toMatch(/^[0-9a-f]{16}$/);
    expect(row).toMatchObject({
      path: "/mcp",
      status: 200,
      user_agent: "TestAgent/1.0",
      detail: "tools/call request_data",
      referer_host: "news.ycombinator.com",
    });
  });

  it("summarises MCP messages and batches", () => {
    expect(describeMcpCall({ method: "initialize" })).toBe("initialize");
    expect(describeMcpCall({ method: "initialize", params: { clientInfo: { name: "claude-code", version: "2.0.1" } } })).toBe(
      "initialize claude-code/2.0.1"
    );
    expect(describeMcpCall({ method: "initialize", params: { clientInfo: { name: "<b>x</b>'; --" } } })).toBe("initialize bxb --");
    expect(
      describeMcpCall([
        { method: "tools/list" },
        { method: "tools/call", params: { name: "x", _meta: { "x402/payment": {} } } },
      ])
    ).toBe("tools/list, tools/call x [paid]");
    expect(describeMcpCall("garbage")).toBeUndefined();
  });
});

describe("admin", () => {
  const get = (env: Record<string, unknown>, auth?: string) =>
    app.request("/admin/usage?days=7", { headers: auth ? { Authorization: auth } : {} }, { DB: createTestD1(), ...env }, ctx);

  it("is hidden when no admin token is configured", async () => {
    expect((await get({}, "Bearer anything")).status).toBe(404);
  });

  it("rejects a wrong token", async () => {
    expect((await get({ ADMIN_TOKEN: "s3cret" }, "Bearer nope")).status).toBe(401);
    expect((await get({ ADMIN_TOKEN: "s3cret" })).status).toBe(401);
  });

  it("returns usage stats with the right token", async () => {
    const res = await get({ ADMIN_TOKEN: "s3cret" }, "Bearer s3cret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["days", "by_caller", "by_path", "by_user_agent", "mcp_calls", "paid_calls", "server_errors", "recent", "by_referer", "network_id_funnel", "by_mcp_client", "data_requests"]);
  });
});

describe("admin stats window", () => {
  function seed(db: ReturnType<typeof createTestD1>, ages: number[]) {
    const insert = db.sqlite.prepare(
      `INSERT INTO usage_log (ts, path, method, status, caller_type, caller_name, tier, latency_ms)
       VALUES (datetime('now', ?), '/x', 'GET', 200, 'bot', ?, 'free', 1)`
    );
    // Oldest first, as rows are written
    for (const days of ages) insert.run(`-${days} days`, `age${days}`);
  }

  it("finds the first id inside the window by binary search", async () => {
    const db = createTestD1();
    expect(await firstIdSince(db, "-7 days")).toBe(0);
    seed(db, [40, 30, 20, 10, 6, 5, 2, 1, 0]);
    expect(await firstIdSince(db, "-7 days")).toBe(5);
    expect(await firstIdSince(db, "-90 days")).toBe(1);
    expect(await firstIdSince(db, "-1 hours")).toBe(9);
  });

  it("counts only rows inside the window", async () => {
    const db = createTestD1();
    seed(db, [40, 30, 3, 1]);
    const res = await app.request(
      "/admin/usage?days=7",
      { headers: { Authorization: "Bearer s3cret" } },
      { DB: db, ADMIN_TOKEN: "s3cret" },
      ctx
    );
    const body = (await res.json()) as any;
    expect(body.by_caller.map((r: any) => r.caller_name).sort()).toEqual(["age1", "age3"]);
  });
});

describe("sampled bot rows", () => {
  it("count with their weight in the usage stats", async () => {
    const db = createTestD1();
    const insert = db.sqlite.prepare(
      `INSERT INTO usage_log (ts, path, method, status, caller_type, caller_name, tier, latency_ms, weight)
       VALUES (datetime('now'), '/v1/solana-validators/validators', 'GET', 402, ?, ?, 'free', 1, ?)`
    );
    insert.run("bot", "mcpbeat", 10);
    insert.run("bot", "mcpbeat", 10);
    insert.run("agent", "node", 1);
    const res = await app.request(
      "/admin/usage?days=1",
      { headers: { Authorization: "Bearer s3cret" } },
      { DB: db, ADMIN_TOKEN: "s3cret" },
      ctx
    );
    const body = (await res.json()) as any;
    const byName = Object.fromEntries(body.by_caller.map((r: any) => [r.caller_name, r.n]));
    expect(byName).toEqual({ mcpbeat: 20, node: 1 });
    expect(body.by_path[0]).toMatchObject({ path: "/v1/solana-validators/validators", n: 21 });
  });
});

describe("client funnel", () => {
  it("counts clients that used free calls, paid and came back on another day", async () => {
    const db = createTestD1();
    const insert = db.sqlite.prepare(
      `INSERT INTO usage_log (ts, path, method, status, caller_type, caller_name, tier, latency_ms, detail, client_id)
       VALUES (datetime('now', ?), '/mcp', 'POST', 200, ?, NULL, ?, 1, ?, ?)`
    );
    insert.run("-2 days", "agent", "free", "tools/call x [free]", "a"); // a: free, then back
    insert.run("-0 days", "agent", "free", "tools/list", "a");
    insert.run("-1 days", "unknown", "free", "tools/call x [free]", "b"); // b: free once
    insert.run("-1 days", "agent", "x402", "tools/call x [paid]", "c"); // c: paid
    insert.run("-0 days", "bot", "free", "tools/call x", "d"); // bots are left out
    insert.run("-0 days", "agent", "free", "initialize cursor/1.2", "a");
    insert.run("-1 days", "agent", "free", "initialize cursor/1.2", "c");
    const res = await app.request(
      "/admin/usage?days=7",
      { headers: { Authorization: "Bearer s3cret" } },
      { DB: db, ADMIN_TOKEN: "s3cret" },
      ctx
    );
    const body = (await res.json()) as any;
    expect(body.network_id_funnel).toMatchObject({
      network_ids: 3,
      tool_network_ids: 3,
      free_network_ids: 2,
      paid_network_ids: 1,
      returning_network_ids: 1,
      returning_free_network_ids: 1,
      rates: { tool: "3/3 (100%)", free: "2/3 (67%)", paid: "1/3 (33%)", returning: "1/3 (33%)" },
    });
    expect(body.network_id_funnel.note).toContain("not people");
    expect(body.by_mcp_client).toMatchObject([{ mcp_client: "cursor/1.2", caller_type: "agent", n: 2, clients: 2 }]);
  });
});
