import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { app } from "../src/index";
import { datasets } from "../src/datasets/registry";
import { solanaValidators } from "../src/datasets/solana-validators";
import { mountDatasets } from "../src/platform/dataset";
import { buildPaidRoutes, readX402Config } from "../src/platform/x402";
import { validateBazaarRouteExtensions } from "@x402/extensions/bazaar";
import type { AppEnv } from "../src/types";
import { SERVICE } from "../src/service";
import { createTestD1 } from "./helpers/d1";
import { EXAMPLE_VOTE, FIXTURE_VOTE, stubSolanaRpc } from "./helpers/solana";

afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

function request(path: string, env: Record<string, unknown> = {}) {
  return app.request(path, {}, { DB: createTestD1(), ...env }, ctx);
}

describe("discovery", () => {
  it("serves llms.txt listing every dataset", async () => {
    const res = await request("/llms.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const d of datasets) expect(body).toContain(`/docs/${d.id}.md`);
    // Plain-language sections for assistants reading it on a user's behalf
    expect(body).toContain("## Questions this answers");
    expect(body).toContain("- Check a Solana validator before staking: ");
    expect(body).toContain("## Use it from an AI assistant");
    expect(body).toMatch(/remote MCP server `https?:\/\/[^`]+\/mcp`/);
    expect(body).toContain("costs $0.001 to $0.002");
  });

  it("serves the dataset catalog with prices", async () => {
    const res = await request("/v1/datasets");
    const body = (await res.json()) as {
      data: Array<{ id: string; endpoints: Array<{ price_usd: string }> }>;
    };
    const sol = body.data.find((d) => d.id === "solana-validators")!;
    expect(sol.endpoints.some((e) => e.price_usd === "free")).toBe(true);
    expect(sol.endpoints.some((e) => e.price_usd.startsWith("$"))).toBe(true);
  });

  it("serves per-dataset markdown docs", async () => {
    const res = await request("/docs/solana-validators.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("GET /v1/solana-validators/validator");
  });
});

describe("solana-validators handlers", () => {
  // Handlers mounted without the payment middleware
  const bare = new Hono<AppEnv>();
  mountDatasets(bare, [solanaValidators]);
  const get = (path: string) => bare.request(path, {}, { DB: createTestD1() });

  it("serves the free network summary", async () => {
    stubSolanaRpc();
    const res = await request("/v1/solana-validators/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.validators.total).toBe(31);
    expect(body.attribution.licence).toBe("Public on-chain data");
  });

  it("serves one validator", async () => {
    stubSolanaRpc();
    const res = await get(`/v1/solana-validators/validator?vote=${FIXTURE_VOTE}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.vote_pubkey).toBe(FIXTURE_VOTE);
  });

  it("validates list parameters", async () => {
    stubSolanaRpc();
    expect((await get("/v1/solana-validators/validators?limit=500")).status).toBe(400);
    expect((await get("/v1/solana-validators/validators?sort=random")).status).toBe(400);
    expect((await get("/v1/solana-validators/validators?limit=5")).status).toBe(200);
  });
});

describe("x402", () => {
  it("chooses the facilitator from configuration", () => {
    const base = { DB: createTestD1(), X402_PAY_TO: "0xabc" };
    expect(readX402Config({ ...base, X402_PAY_TO: "" })).toBeNull();
    expect(readX402Config(base)?.facilitator).toBe("https://x402.org/facilitator");
    const cdp = readX402Config({ ...base, CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "secret" });
    expect(cdp?.facilitator).toBe("cdp");
    expect(cdp?.cdpKey).toEqual({ id: "id", secret: "secret" });
    const explicit = readX402Config({ ...base, CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "s", X402_FACILITATOR_URL: "https://f.example" });
    expect(explicit?.facilitator).toBe("https://f.example");
    expect(explicit?.cdpKey).toBeUndefined();
  });

  it("refuses paid endpoints when no payee is configured", async () => {
    const res = await request(`/v1/solana-validators/validator?vote=${FIXTURE_VOTE}`);
    expect(res.status).toBe(503);
  });

  it("builds one paid route per priced endpoint", () => {
    const routes = buildPaidRoutes(datasets, {
      payTo: "0x0000000000000000000000000000000000000001",
      network: "eip155:84532",
      facilitator: "https://example.invalid",
    }) as Record<string, { accepts: { price: string } }>;
    expect(Object.keys(routes)).toEqual([
      "GET /v1/solana-validators/validator",
      "GET /v1/solana-validators/validators",
    ]);
    expect(routes["GET /v1/solana-validators/validator"].accepts.price).toBe("$0.001");
    expect(routes["GET /v1/solana-validators/validators"].accepts.price).toBe("$0.002");
  });

  it("declares the Base Builder Code on every paid route when configured", () => {
    const base = { X402_PAY_TO: "0x0000000000000000000000000000000000000001", X402_NETWORK: "eip155:8453" };
    const config = readX402Config({ ...base, BASE_BUILDER_CODE: " bc_test123 " } as any)!;
    expect(config.builderCode).toBe("bc_test123");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readX402Config({ ...base, BASE_BUILDER_CODE: "Not-Valid!" } as any)!.builderCode).toBeUndefined();
    warn.mockRestore();
    const routes = buildPaidRoutes(datasets, config) as Record<string, any>;
    for (const route of Object.values(routes)) {
      expect(route.extensions["builder-code"].info).toEqual({ a: "bc_test123" });
      expect(route.extensions.bazaar).toBeDefined();
    }
    const without = buildPaidRoutes(datasets, readX402Config(base as any)!) as Record<string, any>;
    expect(without["GET /v1/solana-validators/validator"].extensions["builder-code"]).toBeUndefined();
  });

  it("declares valid x402 Bazaar discovery metadata on every paid route", () => {
    const routes = buildPaidRoutes(datasets, {
      payTo: "0x0000000000000000000000000000000000000001",
      network: "eip155:84532",
      facilitator: "https://example.invalid",
    }) as Record<string, any>;
    // The official validator reports problems as warnings
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateBazaarRouteExtensions(routes as any);
    expect(warn.mock.calls).toEqual([]);
    warn.mockRestore();
    for (const [key, route] of Object.entries(routes)) {
      const bazaar = route.extensions?.bazaar;
      expect(bazaar, key).toBeDefined();
      expect(bazaar.info.output.example.attribution.licence).toBe("Public on-chain data");
      expect(route.serviceName).toBe(SERVICE.name);
      expect(route.tags.length).toBeLessThanOrEqual(5);
    }
    const body = routes["GET /v1/solana-validators/validators"].unpaidResponseBody().body;
    expect(body.free_endpoints).toEqual(["/v1/solana-validators/summary"]);
    const one = routes["GET /v1/solana-validators/validator"].extensions.bazaar.info.input;
    expect(one.queryParams).toEqual({ vote: EXAMPLE_VOTE });
    const list = routes["GET /v1/solana-validators/validators"].extensions.bazaar.info.input;
    expect(list.queryParams).toEqual({ sort: "credits", max_commission: "5", min_stake_sol: "100000", limit: "10" });
  });
});
