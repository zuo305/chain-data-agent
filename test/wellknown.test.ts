import { describe, expect, it } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { app } from "../src/index";
import { datasets } from "../src/datasets/registry";
import { createTestD1 } from "./helpers/d1";
import { SERVICE } from "../src/service";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as any;
const PAY_TO = "0x2D6F7D1e969a3C6218599B348EbBBDdc7f583948";
const get = (path: string, env: Record<string, unknown> = {}) =>
  app.request(`https://example.test${path}`, {}, { DB: createTestD1(), X402_PAY_TO: PAY_TO, ...env }, ctx);

const paidCount = datasets.flatMap((d) => d.endpoints).filter((e) => e.price).length;
const allCount = datasets.flatMap((d) => d.endpoints).length;

describe("discovery files", () => {
  it("serves a valid OpenAPI 3.1 document with x402 prices", async () => {
    const res = await get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const doc = (await res.json()) as any;
    await expect(SwaggerParser.validate(structuredClone(doc))).resolves.toBeDefined();
    expect(doc.servers[0].url).toBe("https://example.test");
    const detail = doc.paths["/v1/solana-validators/validator"].get;
    expect(detail.parameters[0]).toMatchObject({ name: "vote", in: "query" });
    expect(detail["x-x402"]).toMatchObject({ price: "$0.001", network: "eip155:84532", payTo: PAY_TO });
    expect(detail["x-payment-info"]).toEqual({
      price: { mode: "fixed", currency: "USD", amount: "0.001" },
      protocols: [{ x402: {} }],
    });
    expect(detail.security).toEqual([]);
    expect(detail.responses["402"]).toBeDefined();
    expect(doc.paths["/v1/solana-validators/summary"].get["x-x402"]).toBeUndefined();
    expect(doc.paths["/v1/solana-validators/summary"].get["x-payment-info"]).toBeUndefined();
    expect((await get("/swagger.json")).status).toBe(200);
  });

  it("serves an x402 manifest with complete payment entries", async () => {
    const res = await get("/.well-known/x402");
    const m = (await res.json()) as any;
    expect(m.x402Version).toBe(2);
    expect(m.resources).toHaveLength(paidCount);
    const list = m.resources.find((r: any) => r.url.endsWith("/validators"));
    expect(list).toMatchObject({
      url: "https://example.test/v1/solana-validators/validators",
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "2000",
      payTo: PAY_TO,
    });
    expect((await get("/.well-known/x402.json")).status).toBe(200);
  });

  it("lists bare URLs in the x402 manifest when payments are not configured", async () => {
    const m = (await (await get("/.well-known/x402", { X402_PAY_TO: "" })).json()) as any;
    expect(m.resources.every((r: any) => Object.keys(r).join() === "url")).toBe(true);
  });

  it("serves an MCP server card listing every tool", async () => {
    for (const path of [
      "/.well-known/mcp/server-card.json",
      "/.well-known/mcp.json",
      "/.well-known/mcp",
      "/mcp/server-card",
    ]) {
      const card = (await (await get(path)).json()) as any;
      expect(card.serverInfo.title).toBe(SERVICE.mcpTitle);
      expect(card.transport).toEqual({ type: "streamable-http", url: "https://example.test/mcp" });
      expect(card.tools).toHaveLength(allCount + 1); // plus request_data
      const getTool = card.tools.find((t: any) => t.name === "solana_validators_get_validator");
      expect(Object.keys(getTool.inputSchema.properties)).toEqual(["vote", "identity"]);
      for (const tool of card.tools) {
        expect(tool.annotations.destructiveHint).toBe(false);
        if (tool.name === "request_data") continue; // returns a confirmation, no data envelope
        expect(tool.outputSchema, tool.name).toMatchObject({ type: "object", required: expect.arrayContaining(["attribution"]) });
        expect(tool.annotations.destructiveHint).toBe(false);
      }
      expect(card.prompts).toHaveLength(2);
      expect(card.resources.map((r: any) => r.uri)).toContain("https://example.test/docs/solana-validators.md");
    }
  });

  it("publishes the same tool schemas in the server card as the live MCP server", async () => {
    const card = (await (await get("/.well-known/mcp/server-card.json")).json()) as any;
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
    const live = ((await res.json()) as any).result.tools;
    for (const tool of live) {
      const fromCard = card.tools.find((t: any) => t.name === tool.name);
      expect(fromCard.description).toBe(tool.description);
      expect(fromCard.outputSchema).toEqual(tool.outputSchema);
      expect(Object.keys(fromCard.inputSchema.properties)).toEqual(Object.keys(tool.inputSchema.properties ?? {}));
    }
  });

  it("serves agents.json pointing at the OpenAPI document", async () => {
    const doc = (await (await get("/agents.json")).json()) as any;
    expect(doc.agentsJson).toBe("0.1.0");
    expect(doc.sources[0].path).toBe("https://example.test/openapi.json");
    expect(doc.flows).toHaveLength(allCount);
  });

  it("serves an A2A agent card listing every tool as a skill", async () => {
    for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      const card = (await res.json()) as any;
      expect(card).toMatchObject({ protocolVersion: "0.3.0", url: "https://example.test/mcp" });
      expect(card.skills).toHaveLength(allCount);
      expect(card.skills.find((s: any) => s.id === "solana_validators_get_network_summary").tags).toContain("free");
    }
  });

  it("serves the Glama claim verbatim only when configured", async () => {
    expect((await get("/.well-known/glama.json")).status).toBe(404);
    const claim = '{"$schema":"https://glama.ai/mcp/schemas/connector.json","claim":"abc"}';
    const res = await get("/.well-known/glama.json", { GLAMA_CONNECTOR_JSON: claim });
    expect(await res.text()).toBe(claim);
  });

  it("serves the 402 Index verification hash only when configured", async () => {
    expect((await get("/.well-known/402index-verify.txt")).status).toBe(404);
    const res = await get("/.well-known/402index-verify.txt", { INDEX402_VERIFY_HASH: "abc123" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });

  it("serves robots.txt, sitemap.xml and an icon", async () => {
    expect(await (await get("/robots.txt")).text()).toContain("Sitemap: https://example.test/sitemap.xml");
    expect(await (await get("/sitemap.xml")).text()).toContain("<loc>https://example.test/docs/solana-validators.md</loc>");
    const icon = await get("/favicon.ico");
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
  });
});
