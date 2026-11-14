import type { MiddlewareHandler } from "hono";
import type { AppEnv, CallerType } from "../types";
import { clientId, tracksClient } from "./clientid";

// Known AI agent and crawler signatures (user-agent substrings).
// Checked first; then generic rules below classify the rest.
const AGENT_SIGNATURES: Array<{ pattern: RegExp; name: string; type: CallerType }> = [
  { pattern: /Claude-User/i, name: "Claude-User", type: "agent" },
  { pattern: /Claude-SearchBot/i, name: "Claude-SearchBot", type: "bot" },
  { pattern: /ClaudeBot/i, name: "ClaudeBot", type: "bot" },
  { pattern: /ChatGPT-User/i, name: "ChatGPT-User", type: "agent" },
  { pattern: /OAI-SearchBot/i, name: "OAI-SearchBot", type: "bot" },
  { pattern: /GPTBot/i, name: "GPTBot", type: "bot" },
  { pattern: /Perplexity-User/i, name: "Perplexity-User", type: "agent" },
  { pattern: /PerplexityBot/i, name: "PerplexityBot", type: "bot" },
  { pattern: /Amazonbot/i, name: "Amazonbot", type: "bot" },
  { pattern: /CCBot/i, name: "CCBot", type: "bot" },
  { pattern: /Bytespider/i, name: "Bytespider", type: "bot" },
  // MCP clients of developer tools, so real developer use is told apart from
  // unnamed scripts
  { pattern: /^codex-mcp-client\b/i, name: "codex-mcp-client", type: "agent" },
  { pattern: /^claude-code\b/i, name: "claude-code", type: "agent" },
  { pattern: /^(cursor|windsurf|cline|roo-code|zed|goose|continue)\b/i, name: "dev-mcp-client", type: "agent" },
  // Automated browsers send a normal "Mozilla/5.0" user agent, so they would
  // otherwise be counted as human visitors
  { pattern: /HeadlessChrome|PhantomJS|Puppeteer|Playwright|Lighthouse/i, name: "headless-browser", type: "bot" },
];

// Self-identified automated clients: crawler, monitor, survey and directory
// keywords, a statement that no payment is made, or contact details (a
// "+https://..." URL or an email address), which by convention only bots put
// in their user agent. Many of these start with "Mozilla/5.0 (compatible;
// ...)", so this check must run before the browser check.
const BOT_HINT = new RegExp(
  [
    "bot\\b|bot\\/|crawler|spider|scraper|probe|monitor|verif|explorer|health|liveness|scan|index|check|status",
    "survey|census|study|research|observer|observatory|collector|inventory|catalog|registry|roster|archive",
    "watch|trust|oracle|rating|audit|inspect|ispettore|measure|harness|scout|spotcheck|lint|etl\\b|reader\\b",
    "no payment|never pays|without paying|unpaid|read-only",
    "\\+https?:\\/\\/|[\\w.-]+@[\\w-]+\\.[a-z]",
  ].join("|"),
  "i"
);

// "Mozilla/5.0 (compatible; Name/1.0)" from anything but old Internet Explorer
// is a tool presenting itself as a browser
const COMPATIBLE_TOOL = /compatible;\s*(?!MSIE)/i;

// Paths that only vulnerability scanners request (leaked config, backups, VCS)
const SCANNER_PATH =
  /^\/(\.env|\.git|\.aws|\.ssh|\.DS_Store|\.htpasswd|\.vscode|wp-|actuator|backup|phpmyadmin|config\.|docker-compose|elmah\.axd|server-status)|\.(sql|bak|php)$/i;

export const isScannerPath = (path: string) => SCANNER_PATH.test(path);

// HTTP libraries and runtimes: scripts and agents written by developers
const GENERIC_CLIENT = /^(curl|wget|python-requests|python-httpx|httpx|aiohttp|axios|node-fetch|undici|node|bun|deno|go-http-client|okhttp|java|ruby|php)\b/i;

const BROWSER = /Mozilla\/5\.0/i;

// Product name from a user agent: "Mozilla/5.0 (compatible; Agent402/1.0; ...)"
// gives "Agent402", "mcpbeat/0.1 (...)" gives "mcpbeat".
export function productName(userAgent: string): string {
  const compatible = /compatible;\s*([^;/)]+)/i.exec(userAgent);
  const name = compatible ? compatible[1] : userAgent.split(/[/(;]/)[0];
  return name.trim().slice(0, 40) || "unnamed";
}

export function classifyCaller(userAgent: string | null): { type: CallerType; name: string | null } {
  const ua = userAgent?.trim();
  if (!ua) return { type: "unknown", name: null };

  for (const sig of AGENT_SIGNATURES) {
    if (sig.pattern.test(ua)) return { type: sig.type, name: sig.name };
  }
  if (BOT_HINT.test(ua) || COMPATIBLE_TOOL.test(ua)) return { type: "bot", name: productName(ua) };
  if (GENERIC_CLIENT.test(ua)) return { type: "agent", name: productName(ua).toLowerCase() };
  if (BROWSER.test(ua)) return { type: "human", name: null };

  return { type: "unknown", name: productName(ua) };
}

// Host of the Referer header when it points to another site; own pages and
// malformed values give null. Path and query are dropped.
export function refererHost(referer: string | null | undefined, ownHost: string): string | null {
  if (!referer) return null;
  try {
    const host = new URL(referer).hostname.toLowerCase();
    return host && host !== ownHost.toLowerCase() ? host.slice(0, 100) : null;
  } catch {
    return null;
  }
}

// Short error description for the usage log, so a 5xx can be diagnosed from
// /admin/usage alone. Long hex strings (signatures, keys, hashes) are masked.
export const ERROR_DETAIL_MAX = 200;

export function errorDetail(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text
    .replace(/(0x)?[0-9a-f]{24,}/gi, "<hex>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ERROR_DETAIL_MAX);
}

// Appends a tag to the request's log detail, keeping what is already there
export function appendLogDetail(current: string | undefined, tag: string): string {
  return current ? `${current} ${tag}` : tag;
}

// Self-identified bots make most requests, and each logged request is a row
// written against D1's daily limit. Their routine requests are logged as a
// 1-in-BOT_LOG_SAMPLE sample with that weight; rows that matter on their own
// (server errors, payments, free calls, tool calls, and MCP initialize, which
// names the client) are always logged.
export const BOT_LOG_SAMPLE = 10;

export function logWeight(
  entry: { callerType: CallerType; status: number; tier: string; detail: string | null },
  random: () => number = Math.random
): number | null {
  if (entry.callerType !== "bot") return 1;
  const detail = entry.detail ?? "";
  const always = entry.status >= 500 || entry.tier === "x402" || detail.startsWith("tools/call") ||
    detail.startsWith("initialize") ||
    /\[(paid|free)\]/.test(detail);
  if (always) return 1;
  return random() < 1 / BOT_LOG_SAMPLE ? BOT_LOG_SAMPLE : null;
}

export const telemetry: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  const userAgent = c.req.header("User-Agent") ?? null;
  const caller = isScannerPath(c.req.path) ? { type: "bot" as const, name: "vulnerability-scanner" } : classifyCaller(userAgent);
  const accept = c.req.header("Accept") ?? "";

  c.set("callerType", caller.type);
  c.set("callerName", caller.name);
  c.set("wantsMarkdown", accept.includes("text/markdown") || c.req.path.endsWith(".md"));

  await next();

  // MCP clients name themselves in initialize; probes often do so only there
  const mcpClient = /^initialize (\S+)/.exec(c.get("logDetail") ?? "")?.[1];
  const callerType = caller.type !== "bot" && mcpClient && BOT_HINT.test(mcpClient) ? "bot" : caller.type;

  const tier = c.get("tier") ?? "free";
  const weight = logWeight({ callerType, status: c.res.status, tier, detail: c.get("logDetail") ?? null });
  if (weight === null) return;

  const ip = c.req.header("CF-Connecting-IP");
  const client = tracksClient(c.req.method, c.req.path) ? await clientId(ip, c.env.CLIENT_ID_SECRET ?? c.env.ADMIN_TOKEN) : null;
  const record = c.env.DB.prepare(
    `INSERT INTO usage_log (path, method, status, caller_type, caller_name, tier, wants_markdown, latency_ms, user_agent, detail, api_key_id, referer_host, client_id, weight)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    c.req.path,
    c.req.method,
    c.res.status,
    callerType,
    caller.name,
    tier,
    c.get("wantsMarkdown") ? 1 : 0,
    Date.now() - start,
    userAgent?.slice(0, 300) ?? null,
    c.get("logDetail") ?? null,
    c.get("apiKeyId") ?? null,
    refererHost(c.req.header("Referer"), new URL(c.req.url).hostname),
    client,
    weight
  );

  // Do not block the response on logging
  c.executionCtx.waitUntil(
    record.run().catch((err) => console.error("Failed to write usage log", err))
  );
};
