import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import {
  MCP_FREE_CALLS_PER_DAY,
  MCP_FREE_CALLS_PER_TOOL_PER_DAY,
  clientAddress,
  freeCallClient,
  pruneFreeCalls,
  recordFreeCall,
  utcDay,
} from "../src/platform/freecalls";
import { createTestD1 } from "./helpers/d1";
import { FIXTURE_VOTE, stubSolanaRpc } from "./helpers/solana";

beforeEach(() => {
  stubSolanaRpc();
});
afterEach(() => vi.unstubAllGlobals());

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} } as any;
const CLAUDE = { "User-Agent": "claude-code/2.1.0", "CF-Connecting-IP": "203.0.113.7" };

async function seededDb() {
  return createTestD1();
}

// Payments are not configured here, so a call without free calls left
// returns payments_not_configured instead of contacting a facilitator.
async function call(db: D1Database, headers: Record<string, string>, args: Record<string, unknown> = { limit: "5" }, name = "solana_validators_list_validators", meta?: Record<string, unknown>) {
  const res = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }),
    },
    { DB: db },
    ctx
  );
  return ((await res.json()) as any).result;
}

describe("free MCP calls", () => {
  it(`serves ${MCP_FREE_CALLS_PER_DAY} paid-tool calls per client per day, then asks for payment`, async () => {
    const db = await seededDb();
    for (let i = MCP_FREE_CALLS_PER_DAY - 1; i >= 0; i--) {
      const result = await call(db, CLAUDE);
      expect(result.isError).toBe(false);
      expect(result.structuredContent.data.length).toBeGreaterThan(0);
      expect(result.structuredContent.meta.free_call).toMatchObject({ remaining_today: i, limit_per_day: MCP_FREE_CALLS_PER_DAY });
      expect(JSON.parse(result.content[0].text).meta.free_call.remaining_today).toBe(i);
    }
    const after = await call(db, CLAUDE);
    expect(after.isError).toBe(true);
    expect(after.content[0].text).toContain("payments_not_configured");

    // Another client has its own allowance
    expect((await call(db, { ...CLAUDE, "CF-Connecting-IP": "198.51.100.2" })).isError).toBe(false);

    await Promise.all(pending);
    const free = db.sqlite.prepare("SELECT COUNT(*) AS n FROM usage_log WHERE detail LIKE '%[free]'").get() as { n: number };
    expect(free.n).toBe(MCP_FREE_CALLS_PER_DAY + 1);
  });

  it("does not use up a free call when the call fails", async () => {
    const db = await seededDb();
    const failed = await call(db, CLAUDE, { sort: "random" });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain("bad_request");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM mcp_free_calls").get()).toEqual({ n: 0 });
  });

  it("gives bots and calls carrying a payment no free call", async () => {
    const db = await seededDb();
    const bot = await call(db, { "User-Agent": "x402station/0.1 (+https://x402station.io) uptime-probe", "CF-Connecting-IP": "192.0.2.1" });
    expect(bot.content[0].text).toContain("payments_not_configured");
    const paying = await call(db, CLAUDE, undefined, undefined, { "x402/payment": { x402Version: 2 } });
    expect(paying.content[0].text).toContain("payments_not_configured");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM mcp_free_calls").get()).toEqual({ n: 0 });
  });

  it("keeps no IP address and prunes earlier days", async () => {
    const db = createTestD1();
    const today = utcDay();
    const client = await freeCallClient("203.0.113.7", today);
    expect(client).toMatch(/^[0-9a-f]{16}$/);
    expect(await freeCallClient("203.0.113.7", "2000-01-01")).not.toBe(client);
    await recordFreeCall(db, "2000-01-01", client, "solana_validators_list_validators");
    await recordFreeCall(db, today, client, "solana_validators_list_validators");
    await recordFreeCall(db, today, client, "solana_validators_list_validators");
    await pruneFreeCalls(db, today);
    expect(db.sqlite.prepare("SELECT day, client, calls FROM mcp_free_calls ORDER BY client").all()).toEqual([
      { day: today, client, calls: 2 },
      { day: today, client: "tool:solana_validators_list_validators", calls: 2 },
    ]);
  });

  it(`caps each tool at ${MCP_FREE_CALLS_PER_TOOL_PER_DAY} free calls a day across all callers`, async () => {
    const db = await seededDb();
    // Rotating addresses: every caller stays within its own allowance
    let served = 0;
    for (let i = 0; served < MCP_FREE_CALLS_PER_TOOL_PER_DAY; i++) {
      const ip = `198.51.100.${i}`;
      for (let n = 0; n < MCP_FREE_CALLS_PER_DAY && served < MCP_FREE_CALLS_PER_TOOL_PER_DAY; n++, served++) {
        expect((await call(db, { ...CLAUDE, "CF-Connecting-IP": ip })).isError).toBe(false);
      }
    }
    const fresh = await call(db, { ...CLAUDE, "CF-Connecting-IP": "192.0.2.200" });
    expect(fresh.content[0].text).toContain("payments_not_configured");
    // Other tools keep their own cap
    expect((await call(db, { ...CLAUDE, "CF-Connecting-IP": "192.0.2.200" }, { vote: FIXTURE_VOTE }, "solana_validators_get_validator")).isError).toBe(false);
  });

  it("groups IPv6 addresses by their /64 network", () => {
    expect(clientAddress("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientAddress("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(clientAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddress(undefined)).toBe("unknown");
  });

  it("tells agents about the free calls", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      },
      { DB: createTestD1() },
      ctx
    );
    const tools = ((await res.json()) as any).result.tools as Array<{ name: string; description: string }>;
    const search = tools.find((t) => t.name === "solana_validators_list_validators")!;
    expect(search.description).toContain(`first ${MCP_FREE_CALLS_PER_DAY} paid-tool calls per day are free`);
  });
});
