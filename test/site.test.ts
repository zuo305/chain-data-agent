import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { escapeHtml, listingBadges, verificationMeta } from "../src/platform/site";
import { createTestD1 } from "./helpers/d1";
import { SERVICE } from "../src/service";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as any;
const get = (path: string, accept: string) =>
  app.request(`https://example.test${path}`, { headers: { Accept: accept } }, { DB: createTestD1(), X402_PAY_TO: "0xabc", X402_NETWORK: "eip155:8453" }, ctx);

describe("human pages", () => {
  it("serves the home page to browsers", async () => {
    const res = await get("/", "text/html,application/xhtml+xml");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`<title>${SERVICE.name}: on-chain data for AI agents</title>`);
    expect(html).toContain("Solana validator stats");
    expect(html).toContain("https://example.test/mcp");
    expect(html).toContain("USDC on Base");
    expect(html).toContain("solana_validators_list_validators");
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("<b>In plain words:</b>");
    expect(html).toContain("look up live Solana validator stats and SOL stake unlock calendar data for you");
    expect(html).toContain("Each answer costs $0.001 to $0.002");
  });

  it("keeps the JSON service index for API clients", async () => {
    const res = await get("/", "application/json");
    expect(((await res.json()) as any).mcp).toBe("/mcp");
    expect(res.headers.get("vary")).toBe("Accept");
  });

  it("serves the API reference as HTML, and markdown on request", async () => {
    const html = await (await get("/docs", "text/html")).text();
    expect(html).toContain('<section id="solana-validators">');
    expect(html).toContain("<code>vote</code>");
    const md = await (await get("/docs", "text/markdown")).text();
    expect(md.startsWith("# API overview")).toBe(true);
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("renders directory badges from config, https only", async () => {
    const json = JSON.stringify([
      { href: "https://dir.example/x?verify=abc", img: "https://dir.example/badge.svg", alt: "Dir" },
      { href: "javascript:alert(1)", img: "https://dir.example/b.svg", alt: "bad" },
    ]);
    expect(listingBadges(json)).toEqual([{ href: "https://dir.example/x?verify=abc", img: "https://dir.example/badge.svg", alt: "Dir" }]);
    expect(listingBadges("not json")).toEqual([]);
    const res = await app.request("https://example.test/", { headers: { Accept: "text/html" } }, { DB: createTestD1(), LISTING_BADGES_JSON: json }, ctx);
    const html = await res.text();
    expect(html).toContain('<a href="https://dir.example/x?verify=abc" rel="noopener"><img src="https://dir.example/badge.svg" alt="Dir" height="40"></a>');
    expect(html).not.toContain("javascript:");
  });

  it("adds site verification meta tags from config", async () => {
    const json = JSON.stringify([{ name: "dir-verification", content: "token=a:b" }, { name: 1 }]);
    expect(verificationMeta(json)).toEqual([{ name: "dir-verification", content: "token=a:b" }]);
    const res = await app.request("https://example.test/", { headers: { Accept: "text/html" } }, { DB: createTestD1(), SITE_VERIFICATION_META_JSON: json }, ctx);
    expect(await res.text()).toContain('<meta name="dir-verification" content="token=a:b">');
  });

  it("shows browsers opening the MCP endpoint how to connect, and leaves MCP clients alone", async () => {
    const page = await get("/mcp", "text/html,application/xhtml+xml");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<h1>MCP server</h1>");
    expect(html).toContain(`claude mcp add --transport http ${SERVICE.mcpName} https://example.test/mcp`);
    expect(html).toContain("<code>solana_validators_get_validator</code>");
    // An MCP client's GET (event stream) still reaches the transport
    const sse = await get("/mcp", "text/event-stream");
    expect(sse.headers.get("content-type") ?? "").not.toContain("text/html");
  });
});
