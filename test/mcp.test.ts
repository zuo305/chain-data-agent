import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { solanaValidators } from "../src/datasets/solana-validators";
import { PAYMENT_DESCRIPTION_MAX, paymentDescription, toolRequestPath } from "../src/platform/mcp";
import { datasets } from "../src/datasets/registry";
import { SERVICE } from "../src/service";
import { createTestD1 } from "./helpers/d1";
import { FIXTURE_VOTE, stubSolanaRpc } from "./helpers/solana";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

beforeEach(() => {
  stubSolanaRpc();
});
afterEach(() => vi.unstubAllGlobals());

async function seededDb() {
  return createTestD1();
}

async function rpc(db: D1Database, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    { DB: db },
    ctx
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: any; error?: any };
}

describe("MCP server", () => {
  it.each([undefined, "*/*", "application/json"])("answers POSTs with Accept %s", async (accept) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accept) headers.Accept = accept;
    const res = await app.request(
      "/mcp",
      { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) },
      { DB: createTestD1() },
      ctx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("answers JSON-RPC POSTed to the root path", async () => {
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      },
      { DB: createTestD1() },
      ctx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("initializes", async () => {
    const { result } = await rpc(createTestD1(), "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(result.serverInfo.name).toBe(SERVICE.mcpName);
    expect(result.serverInfo.title).toBe(SERVICE.mcpTitle);
    expect(result.serverInfo.description).toContain("x402");
    expect(result.instructions).toContain("solana_validators_get_network_summary");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.prompts).toBeDefined();
    expect(result.capabilities.resources).toBeDefined();
    expect(result.serverInfo.icons[0].src).toMatch(/\/icon\.svg$/);
  });

  it("lists one tool per endpoint with prices and schemas", async () => {
    const { result } = await rpc(createTestD1(), "tools/list");
    const tools = result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    expect(tools.map((t) => t.name)).toEqual([
      "solana_validators_get_network_summary",
      "solana_validators_get_validator",
      "solana_validators_list_validators",
      "solana_unlocks_get_unlock_summary",
      "solana_unlocks_get_unlock_calendar",
      "solana_unlocks_list_unlocks",
      "request_data",
    ]);
    const get = tools.find((t) => t.name === "solana_validators_get_validator")!;
    expect(get.description).toContain("$0.001");
    expect(Object.keys(get.inputSchema.properties)).toEqual(["vote", "identity"]);
  });

  it("describes tools for agents: verb first, usage notes, price, annotations", async () => {
    const { result } = await rpc(createTestD1(), "tools/list");
    for (const tool of result.tools as Array<any>) {
      if (tool.name === "request_data") continue; // checked in the data request tests
      expect(tool.description).toMatch(/^(Get|Search|Find|List|Resolve)\b/);
      expect(tool.description.length).toBeGreaterThan(150);
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.annotations.title).toBeTruthy();
      expect(tool.outputSchema.required).toEqual(expect.arrayContaining(["meta", "attribution"]));
      for (const [name, prop] of Object.entries<any>(tool.inputSchema.properties ?? {})) {
        expect(prop.description, `${tool.name}.${name}`).toBeTruthy();
      }
    }
  });

  it("lists and renders prompts", async () => {
    const list = (await rpc(createTestD1(), "prompts/list")).result.prompts as Array<any>;
    expect(list.map((p) => p.name)).toEqual(["solana_check_validator", "solana_unlock_outlook"]);
    expect(list[0].arguments.find((a: any) => a.name === "vote").required).toBe(true);
    const { result } = await rpc(createTestD1(), "prompts/get", {
      name: "solana_check_validator",
      arguments: { vote: FIXTURE_VOTE },
    });
    const text = result.messages[0].content.text as string;
    expect(text).toContain(`vote="${FIXTURE_VOTE}"`);
    expect(text).toContain("solana_validators_get_network_summary");
    expect(text).toContain("solana_validators_get_validator");
  });

  it("lists and reads documentation resources", async () => {
    const list = (await rpc(createTestD1(), "resources/list")).result.resources as Array<any>;
    expect(list.map((r) => r.uri)).toEqual([
      "http://localhost/llms.txt",
      "http://localhost/docs/solana-validators.md",
      "http://localhost/docs/solana-unlocks.md",
    ]);
    const { result } = await rpc(createTestD1(), "resources/read", { uri: "http://localhost/docs/solana-validators.md" });
    expect(result.contents[0].text).toContain("MCP tool: `solana_validators_list_validators`");
  });

  it("calls free tools directly", async () => {
    const { result } = await rpc(await seededDb(), "tools/call", {
      name: "solana_validators_get_network_summary",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.data.validators.total).toBe(31);
    expect(result.structuredContent).toEqual(body);
    expect(body.attribution.licence).toBe("Public on-chain data");
  });

  it("returns handler validation errors as tool errors", async () => {
    // A free call (the first of the day for this client) reaches the handler
    const { result } = await rpc(await seededDb(), "tools/call", {
      name: "solana_validators_get_validator",
      arguments: { vote: "not-a-key" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bad_request");
  });

  it("refuses paid tools when payments are not configured", async () => {
    // A bot gets no free calls, so the call goes straight to payment
    const { result } = await rpc(
      await seededDb(),
      "tools/call",
      { name: "solana_validators_get_validator", arguments: { vote: FIXTURE_VOTE } },
      { "User-Agent": "TestProbe/1.0 (+https://probe.example)" }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("payments_not_configured");
  });

  it("keeps payment descriptions within the facilitator's 500 characters", () => {
    for (const dataset of datasets) {
      for (const endpoint of dataset.endpoints.filter((e) => e.price)) {
        const text = paymentDescription(dataset, endpoint);
        expect(text.length, endpoint.toolName).toBeLessThanOrEqual(PAYMENT_DESCRIPTION_MAX);
        expect(text.startsWith(endpoint.summary), endpoint.toolName).toBe(true);
        expect(text).toContain(`Costs ${endpoint.price} per call`);
        expect(text).not.toMatch(/\. [a-z]/); // no sentence cut mid-abbreviation
      }
    }
  });

  it("maps tool arguments onto the REST path", () => {
    const get = solanaValidators.endpoints.find((e) => e.toolName === "get_validator")!;
    expect(toolRequestPath(solanaValidators, get, { vote: "abc" })).toBe("/v1/solana-validators/validator?vote=abc");
    const list = solanaValidators.endpoints.find((e) => e.toolName === "list_validators")!;
    expect(toolRequestPath(solanaValidators, list, { sort: "credits", limit: 5, max_commission: undefined })).toBe(
      "/v1/solana-validators/validators?sort=credits&limit=5"
    );
  });
});

describe("MCP paid tools", () => {
  it("announce the Base Builder Code in the payment requirements", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://facilitator-mcp-bc.test/")) {
        return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
      }
      return realFetch(input, init);
    });
    try {
      const res = await app.request(
        "https://example.test/mcp",
        {
          method: "POST",
          // A self-identified bot gets no free calls, so the tool asks for payment
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": "testbot/1.0 (+https://example.test)" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "solana_validators_get_validator", arguments: { vote: FIXTURE_VOTE } },
          }),
        },
        {
          DB: await seededDb(),
          
          X402_PAY_TO: "0x0000000000000000000000000000000000000001",
          X402_NETWORK: "eip155:84532",
          X402_FACILITATOR_URL: "https://facilitator-mcp-bc.test",
          BASE_BUILDER_CODE: "bc_test123",
        },
        ctx
      );
      const body = (await res.json()) as any;
      const required = JSON.parse(body.result.content[0].text);
      expect(required.error).toContain("Payment required");
      expect(required.extensions["builder-code"].info).toEqual({ a: "bc_test123" });
    } finally {
      vi.unstubAllGlobals();
      stubSolanaRpc();
    }
  });
});
