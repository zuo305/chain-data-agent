import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { DATA_REQUESTS_PER_CLIENT_PER_DAY, DATA_REQUEST_MAX_LENGTH } from "../src/platform/requests";
import { createTestD1 } from "./helpers/d1";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as any;

function post(db: D1Database, body: unknown, ip = "203.0.113.9") {
  return app.request(
    "https://example.test/v1/data-requests",
    { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) },
    { DB: db, CLIENT_ID_SECRET: "k" },
    ctx
  );
}

async function mcpCall(db: D1Database, args: Record<string, unknown>) {
  const res = await app.request(
    "https://example.test/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "CF-Connecting-IP": "203.0.113.10" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_data", arguments: args } }),
    },
    { DB: db, CLIENT_ID_SECRET: "k" },
    ctx
  );
  return ((await res.json()) as any).result;
}

describe("data requests", () => {
  it("stores a request sent over HTTP, trimmed and capped", async () => {
    const db = createTestD1();
    const res = await post(db, { request: "  Token unlock\n schedules ", use_case: "x".repeat(900) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.received).toBe(true);
    const row = db.sqlite.prepare("SELECT request, use_case, channel, client_id FROM data_request").get() as any;
    expect(row.request).toBe("Token unlock schedules");
    expect(row.use_case).toHaveLength(DATA_REQUEST_MAX_LENGTH);
    expect(row.channel).toBe("http");
    expect(row.client_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects empty requests", async () => {
    const db = createTestD1();
    expect((await post(db, { request: " " })).status).toBe(400);
    expect((await post(db, "not an object")).status).toBe(400);
  });

  it("limits requests per client and day", async () => {
    const db = createTestD1();
    for (let i = 0; i < DATA_REQUESTS_PER_CLIENT_PER_DAY; i++) expect((await post(db, { request: `need ${i}` })).status).toBe(200);
    expect((await post(db, { request: "one more" })).status).toBe(429);
    // Another client is not affected
    expect((await post(db, { request: "other" }, "198.51.100.4")).status).toBe(200);
  });

  it("accepts requests through the free request_data MCP tool", async () => {
    const db = createTestD1();
    const result = await mcpCall(db, { request: "sale prices", use_case: "valuation agent" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).data.received).toBe(true);
    const row = db.sqlite.prepare("SELECT request, use_case, channel FROM data_request").get() as any;
    expect(row).toEqual({ request: "sale prices", use_case: "valuation agent", channel: "mcp" });
    expect((await mcpCall(db, { request: "" })).isError).toBe(true);
  });

  it("is listed with an honest, verb-first description and a write annotation", async () => {
    const res = await app.request(
      "https://example.test/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      { DB: createTestD1() },
      ctx
    );
    const tool = ((await res.json()) as any).result.tools.find((t: any) => t.name === "request_data");
    expect(tool.description).toMatch(/^Request\b/);
    expect(tool.description).toContain("Do not include personal information");
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool.inputSchema.required).toEqual(["request"]);
  });

  it("is offered on the home and MCP pages", async () => {
    const env = { DB: createTestD1(), CONTACT_EMAIL: "data@example.test" };
    for (const path of ["/", "/mcp"]) {
      const html = await (await app.request(`https://example.test${path}`, { headers: { Accept: "text/html" } }, env, ctx)).text();
      expect(html, path).toContain("<code>request_data</code>");
      expect(html, path).toContain('href="mailto:data@example.test"');
    }
  });
});
