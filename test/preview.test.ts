import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { solanaValidators } from "../src/datasets/solana-validators";
import { findPaidEndpoint, withPreview } from "../src/platform/x402";
import type { AppEnv } from "../src/types";
import { createTestD1 } from "./helpers/d1";
import { FIXTURE_VOTE, stubSolanaRpc } from "./helpers/solana";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

const sv = solanaValidators;
const UNKNOWN_VOTE = "11111111111111111111111111111111";

beforeEach(() => {
  stubSolanaRpc();
});
afterEach(() => vi.unstubAllGlobals());

async function seededDb() {
  return createTestD1();
}

// Answers every request with a 402 like the x402 middleware, plus the preview
async function unpaid(path: string, upstream?: () => Response) {
  const app = new Hono<AppEnv>();
  app.get("*", (c) => {
    const res =
      upstream?.() ??
      new Response(JSON.stringify({ error: "payment_required" }), {
        status: 402,
        headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": "abc" },
      });
    return withPreview(c, res, findPaidEndpoint([sv], c.req.method, c.req.path));
  });
  return app.request(`https://example.test${path}`, {}, { DB: await seededDb() }, ctx);
}

describe("402 preview", () => {
  it("matches paid endpoints only", () => {
    expect(findPaidEndpoint([sv], "GET", "/v1/solana-validators/validator")?.endpoint.toolName).toBe("get_validator");
    expect(findPaidEndpoint([sv], "GET", "/v1/solana-validators/validators")?.endpoint.toolName).toBe("list_validators");
    expect(findPaidEndpoint([sv], "GET", "/v1/solana-validators/summary")).toBeNull();
    expect(findPaidEndpoint([sv], "POST", "/v1/solana-validators/validators")).toBeNull();
  });

  it("adds a list preview to the 402 body and keeps the payment headers", async () => {
    const res = await unpaid("/v1/solana-validators/validators?max_commission=5");
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBe("abc");
    const body = (await res.json()) as any;
    expect(body.error).toBe("payment_required");
    expect(body.preview).toMatchObject({ valid: true, matched: 15 });
  });

  it("reports invalid input before payment", async () => {
    const body = (await (await unpaid("/v1/solana-validators/validators?sort=random")).json()) as any;
    expect(body.preview).toMatchObject({ valid: false, error: "bad_request" });
    const one = (await (await unpaid("/v1/solana-validators/validator")).json()) as any;
    expect(one.preview).toMatchObject({ valid: false, error: "bad_request" });
  });

  it("previews whether a validator exists without its stats", async () => {
    const found = (await (await unpaid(`/v1/solana-validators/validator?vote=${FIXTURE_VOTE}`)).json()) as any;
    expect(found.preview).toMatchObject({ valid: true, found: true });
    expect(found.preview.stake).toBeUndefined();
    const missing = (await (await unpaid(`/v1/solana-validators/validator?vote=${UNKNOWN_VOTE}`)).json()) as any;
    expect(missing.preview).toMatchObject({ valid: true, found: false });
  });

  it("leaves the preview out when the RPC is down", async () => {
    vi.unstubAllGlobals();
    stubSolanaRpc({ fail: true });
    const res = await unpaid(`/v1/solana-validators/validator?vote=${FIXTURE_VOTE}`);
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).preview).toBeUndefined();
  });

  it("replaces the browser paywall with a readable page", async () => {
    const required = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", payTo: "0x00000000000000000000000000000000000000aa" }],
      })
    );
    const res = await unpaid(
      "/v1/solana-validators/validators?max_commission=5",
      () =>
        new Response("<html>Payment Required</html>", {
          status: 402,
          headers: { "Content-Type": "text/html", "PAYMENT-REQUIRED": required },
        })
    );
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBe(required);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Payment required: $");
    expect(html).toContain("Base");
    expect(html).toContain("https://basescan.org/address/0x00000000000000000000000000000000000000aa");
    expect(html).toContain("Free preview");
    expect(html).toContain("&quot;valid&quot;: true");
  });

  it("leaves other non-JSON responses untouched", async () => {
    const res = await unpaid(
      "/v1/solana-validators/validators?max_commission=5",
      () => new Response("plain", { status: 402, headers: { "Content-Type": "text/plain" } })
    );
    expect(await res.text()).toBe("plain");
  });
});

describe("402 preview through the x402 middleware", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds the preview to a real unpaid 402", async () => {
    // Stub the facilitator's /supported call made on first use
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://facilitator.test/")) {
        return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
      }
      return realFetch(input, init);
    });
    const env = {
      DB: await seededDb(),
      
      X402_PAY_TO: "0x0000000000000000000000000000000000000001",
      X402_NETWORK: "eip155:84532",
      X402_FACILITATOR_URL: "https://facilitator.test",
    };
    const res = await app.request("https://example.test/v1/solana-validators/validators?max_commission=5", {}, env, ctx);
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const body = (await res.json()) as any;
    expect(body.error).toBe("payment_required");
    expect(body.message).toContain("preview");
    expect(body.preview).toMatchObject({ valid: true, matched: 15 });
  });

  it("announces the Base Builder Code in the PAYMENT-REQUIRED header", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://facilitator-bc.test/")) {
        return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
      }
      return realFetch(input, init);
    });
    const env = {
      DB: await seededDb(),
      
      X402_PAY_TO: "0x0000000000000000000000000000000000000001",
      X402_NETWORK: "eip155:84532",
      X402_FACILITATOR_URL: "https://facilitator-bc.test",
      BASE_BUILDER_CODE: "bc_test123",
    };
    const res = await app.request("https://example.test/v1/solana-validators/validators?max_commission=5", {}, env, ctx);
    expect(res.status).toBe(402);
    const required = JSON.parse(atob(res.headers.get("PAYMENT-REQUIRED")!));
    expect(required.extensions["builder-code"].info).toEqual({ a: "bc_test123" });
  });
});

describe("x402 facilitator outage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers 503 with Retry-After and logs the cause", async () => {
    // The facilitator rejects the /supported call, as when CDP's edge sends a challenge page
    vi.stubGlobal("fetch", async () => new Response("<html>Just a moment...</html>", { status: 403 }));
    const pending: Promise<unknown>[] = [];
    const logCtx = { ...ctx, waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    const db = createTestD1();
    const env = {
      DB: db,
      
      X402_PAY_TO: "0x0000000000000000000000000000000000000001",
      X402_NETWORK: "eip155:84532",
      X402_FACILITATOR_URL: "https://facilitator-down.test",
    };
    const res = await app.request("https://example.test/v1/solana-validators/validators?max_commission=5", {}, env, logCtx);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(((await res.json()) as any).error).toBe("payment_facilitator_unavailable");
    await Promise.all(pending);
    const row = db.sqlite.prepare("SELECT status, detail FROM usage_log").get() as any;
    expect(row.status).toBe(503);
    expect(row.detail).toMatch(/^\[x402 error\] no payment: /);
  });

  it("retries once when the facilitator fails only briefly", async () => {
    // First /supported call gets the challenge page, the retry succeeds
    let calls = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://facilitator-flaky.test/")) {
        calls++;
        if (calls === 1) return new Response("<html>Just a moment...</html>", { status: 403 });
        return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
      }
      return realFetch(input, init);
    });
    const env = {
      DB: await seededDb(),
      
      X402_PAY_TO: "0x0000000000000000000000000000000000000001",
      X402_NETWORK: "eip155:84532",
      X402_FACILITATOR_URL: "https://facilitator-flaky.test",
    };
    const res = await app.request("https://example.test/v1/solana-validators/validators?max_commission=5", {}, env, ctx);
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error).toBe("payment_required");
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
