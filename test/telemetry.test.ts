import { describe, expect, it } from "vitest";
import { BOT_LOG_SAMPLE, ERROR_DETAIL_MAX, appendLogDetail, classifyCaller, errorDetail, isScannerPath, logWeight, refererHost } from "../src/platform/telemetry";
import { clientId, tracksClient } from "../src/platform/clientid";

// Real user agents seen in production logs
const CASES: Array<[string | null, string, string | null]> = [
  [null, "unknown", null],
  ["", "unknown", null],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "bot", "ClaudeBot"],
  ["Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools/crawler)", "bot", "Agent402"],
  ["Mozilla/5.0 (compatible; verantis-verifier/0.2; +https://verantis.ai)", "bot", "verantis-verifier"],
  ["mcpbeat/0.1 (+https://mcpbeat.com/bot/; liveness check)", "bot", "mcpbeat"],
  ["lumiere-paycheck-prober/1.0 (+https://lumierepaycheck.org)", "bot", "lumiere-paycheck-prober"],
  ["402explorer/0.1 (+https://discover.paygent.net/about)", "bot", "402explorer"],
  ["CarbonMonitor/0.1 healthcheck (+https://carbon-cashmere.de)", "bot", "CarbonMonitor"],
  ["PulseFeed contract crawler/0.1 (+https://pulsefeed.dev/contact)", "bot", "PulseFeed contract crawler"],
  ["curl/8.5.0", "agent", "curl"],
  ["node", "agent", "node"],
  ["python-requests/2.32.3", "agent", "python-requests"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "human", null],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36", "bot", "headless-browser"],
  ["SomeTool/2.0", "unknown", "SomeTool"],
  // Developer MCP clients
  ["codex-mcp-client/0.166.0-alpha.6", "agent", "codex-mcp-client"],
  ["claude-code/2.1.309 (claude-desktop, agent-sdk/0.3.309)", "agent", "claude-code"],
  // Self-identified probes, surveys and directories seen in production
  ["agent-collector/0.1 (+health check; no payment is made)", "bot", "agent-collector"],
  ["entropy-daemon-trust-oracle/2.0", "bot", "entropy-daemon-trust-oracle"],
  ["AnalogHubris-TrustIndex/0.2 (health survey; no payment attached; contact: hello@analoghubris.com)", "bot", "AnalogHubris-TrustIndex"],
  ["BlockchainIQ-ETL (team@blockchainiq.co) x402-roster", "bot", "BlockchainIQ-ETL"],
  ["x402-collector/0.1", "bot", "x402-collector"],
  ["Mizan/0.1 (ispettore x402; https://mizan-bazar.higgsfield.app)", "bot", "Mizan"],
  ["mcplantern-check/0.2", "bot", "mcplantern-check"],
  ["PlumblineIndex/0.1 (reads x402 terms without paying; contact team@protoperfect.io)", "bot", "PlumblineIndex"],
  ["NeurontoPayments-census/1 (read-only x402 endpoint census; never pays)", "bot", "NeurontoPayments-census"],
  ["CreoraPublicReader/1.0", "bot", "CreoraPublicReader"],
  ["Mozilla/5.0 (compatible; StillOS-TrustScore/1.0)", "bot", "StillOS-TrustScore"],
  ["Mozilla/5.0 (compatible; url2md/1.0)", "bot", "url2md"],
  ["Mozilla/5.0 (NovarithmAgentHub audit)", "bot", "Mozilla"],
  // Generic libraries stay agents, browsers stay human
  ["axios/1.20.0", "agent", "axios"],
  ["Deno/2.9.8", "agent", "deno"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15", "human", null],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0", "human", null],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "agent", "ChatGPT-User"],
];

describe("classifyCaller", () => {
  it.each(CASES)("%s", (ua, type, name) => {
    expect(classifyCaller(ua)).toEqual({ type, name });
  });
});

describe("referer host", () => {
  it("keeps only the host of links from other sites", () => {
    expect(refererHost("https://news.ycombinator.com/item?id=123", "example.test")).toBe("news.ycombinator.com");
    expect(refererHost("https://www.Reddit.com/r/mcp/comments/x", "example.test")).toBe("www.reddit.com");
    expect(refererHost("https://example.test/docs/nsw-da.md", "example.test")).toBeNull();
    expect(refererHost("not a url", "example.test")).toBeNull();
    expect(refererHost(undefined, "example.test")).toBeNull();
  });
});

describe("anonymous client id", () => {
  it("is stable across days, keyed by a secret and never the address itself", async () => {
    const id = await clientId("203.0.113.7", "secret-a");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(await clientId("203.0.113.7", "secret-a")).toBe(id);
    expect(await clientId("203.0.113.7", "secret-b")).not.toBe(id);
    expect(await clientId("203.0.113.8", "secret-a")).not.toBe(id);
    expect(await clientId("203.0.113.7", undefined)).toBeNull();
    expect(await clientId(undefined, "secret-a")).toBeNull();
  });

  it("treats an IPv6 /64 as one client", async () => {
    expect(await clientId("2001:db8:1:2::1", "k")).toBe(await clientId("2001:db8:1:2:ffff::9", "k"));
  });

  it("follows API and MCP requests, not page views", () => {
    expect(tracksClient("GET", "/v1/nsw-da/applications")).toBe(true);
    expect(tracksClient("POST", "/mcp")).toBe(true);
    expect(tracksClient("POST", "/")).toBe(true);
    expect(tracksClient("GET", "/")).toBe(false);
    expect(tracksClient("GET", "/docs/nsw-da.md")).toBe(false);
  });
});

describe("error detail", () => {
  it("names the error and masks long hex strings", () => {
    const err = new TypeError(`bad signature 0x${"ab".repeat(32)}\n  at line 3`);
    expect(errorDetail(err)).toBe("TypeError: bad signature <hex> at line 3");
    expect(errorDetail("Facilitator unreachable")).toBe("Facilitator unreachable");
  });

  it("truncates long messages", () => {
    expect(errorDetail(new Error("x ".repeat(500))).length).toBe(ERROR_DETAIL_MAX);
  });

  it("appends to an existing detail", () => {
    expect(appendLogDetail(undefined, "[error] E")).toBe("[error] E");
    expect(appendLogDetail("tools/call nsw_da_search", "[error] E")).toBe("tools/call nsw_da_search [error] E");
  });
});

describe("scanner paths", () => {
  it("flags paths only vulnerability scanners request", () => {
    for (const path of ["/.env", "/.git/config", "/.aws/credentials", "/backup.sql", "/wp-login.php", "/actuator/env"]) {
      expect(isScannerPath(path), path).toBe(true);
    }
    for (const path of ["/", "/mcp", "/docs", "/v1/nsw-da/applications", "/.well-known/x402", "/llms.txt"]) {
      expect(isScannerPath(path), path).toBe(false);
    }
  });
});

describe("bot log sampling", () => {
  const entry = (callerType: any, extra: Partial<{ status: number; tier: string; detail: string | null }> = {}) => ({
    callerType,
    status: 402,
    tier: "free",
    detail: null,
    ...extra,
  });

  it("logs every non-bot request with weight 1", () => {
    for (const type of ["agent", "human", "unknown"]) expect(logWeight(entry(type), () => 0.99)).toBe(1);
  });

  it("samples routine bot requests and weights the kept ones", () => {
    expect(logWeight(entry("bot"), () => 0.05)).toBe(BOT_LOG_SAMPLE);
    expect(logWeight(entry("bot"), () => 0.5)).toBeNull();
  });

  it("always logs bot requests that matter on their own", () => {
    const never = () => 0.99;
    expect(logWeight(entry("bot", { status: 503 }), never)).toBe(1);
    expect(logWeight(entry("bot", { status: 200, tier: "x402" }), never)).toBe(1);
    expect(logWeight(entry("bot", { detail: "tools/call nsw_da_get_application" }), never)).toBe(1);
    expect(logWeight(entry("bot", { detail: "initialize mcpbeat/0.1" }), never)).toBe(1);
    expect(logWeight(entry("bot", { detail: "tools/call x [free]" }), never)).toBe(1);
    expect(logWeight(entry("bot", { detail: "tools/list" }), never)).toBeNull();
  });
});
