import { SERVICE } from "../service";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { type Dataset, type Endpoint, SERVICE_NAME, endpointFullPath, toolName } from "./dataset";
import { catalog } from "./discovery";
import { MCP_FREE_CALLS_PER_DAY } from "./freecalls";
import { readX402Config } from "./x402";

// Human-facing pages (home, API reference, MCP endpoint), generated from dataset
// definitions. Agents keep using llms.txt, OpenAPI and MCP; these pages are
// for developers, directory reviewers and search engines.

const NETWORK_LABELS: Record<string, string> = {
  "eip155:8453": "Base",
  "eip155:84532": "Base Sepolia (testnet)",
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const e = escapeHtml;

const STYLES = `
:root{--bg:#f7f7f5;--surface:#fff;--text:#1c1f23;--muted:#5d6670;--border:#e3e5e8;--accent:#0f766e;--accent-soft:#e6f4f2;--code:#f1f3f4}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--surface:#1b1e21;--text:#e8eaed;--muted:#9aa3ad;--border:#2c3135;--accent:#2dd4bf;--accent-soft:#163632;--code:#24282c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.wrap{max-width:960px;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--border);background:var(--surface)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:60px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;color:var(--text);text-decoration:none}
.brand img{width:28px;height:28px}
nav a{margin-left:16px;color:var(--muted);text-decoration:none;font-size:15px}
nav a:hover{color:var(--accent)}
.hero{padding:56px 0 32px}
.hero h1{font-size:clamp(28px,5vw,40px);line-height:1.2;margin:0 0 12px}
.hero p{font-size:18px;color:var(--muted);margin:0 0 20px;max-width:680px}
.hero .plain{margin-top:20px;max-width:760px}
.hero .plain p{font-size:16px;color:var(--text);margin:0}
.pills{display:flex;gap:8px;flex-wrap:wrap}
.pill{background:var(--accent-soft);color:var(--accent);border-radius:999px;padding:4px 12px;font-size:14px;font-weight:500}
section{padding:24px 0}
h2{font-size:24px;margin:0 0 16px}
h3{font-size:18px;margin:24px 0 8px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
.stat{background:var(--bg);border-radius:8px;padding:12px}
.stat b{display:block;font-size:22px}
.stat span{color:var(--muted);font-size:14px}
table{width:100%;border-collapse:collapse;font-size:15px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:14px}
.table-scroll{overflow-x:auto}
code{background:var(--code);border-radius:4px;padding:1px 5px;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);border-radius:8px;padding:14px;overflow-x:auto;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
pre code{background:none;padding:0}
.price{font-weight:600;white-space:nowrap}
.free{color:var(--accent)}
.muted{color:var(--muted)}
ol.steps{padding-left:20px}
ol.steps li{margin-bottom:6px}
@media (max-width:640px){
table.stack thead{display:none}
table.stack tr{display:block;border-bottom:1px solid var(--border);padding:10px 0}
table.stack td{display:block;border:0;padding:2px 0}
table.stack td.price-cell{margin-top:4px}
.hero{padding:32px 0 16px}
nav a{margin:0 12px 0 0}
}
footer{border-top:1px solid var(--border);margin-top:32px;padding:24px 0;color:var(--muted);font-size:14px}
footer .badges{margin:16px 0 0;display:flex;gap:8px;flex-wrap:wrap}
`;

// Badges from directories that list us, some of which verify ownership by
// finding their badge link on our site. Configured in LISTING_BADGES_JSON as
// [{ "href", "img", "alt" }]; only https URLs are rendered.
type ListingBadge = { href: string; img: string; alt: string };

export function listingBadges(json: string | undefined): ListingBadge[] {
  if (!json) return [];
  try {
    const items = JSON.parse(json) as unknown;
    if (!Array.isArray(items)) return [];
    const isHttps = (v: unknown) => typeof v === "string" && v.startsWith("https://");
    return items
      .filter((b) => b && isHttps(b.href) && isHttps(b.img))
      .map((b) => ({ href: b.href, img: b.img, alt: typeof b.alt === "string" ? b.alt : "" }));
  } catch {
    return [];
  }
}

// Site verification <meta> tags, e.g. for directories that confirm listing
// ownership. Configured in SITE_VERIFICATION_META_JSON as [{ "name", "content" }].
type MetaTag = { name: string; content: string };

export function verificationMeta(json: string | undefined): MetaTag[] {
  if (!json) return [];
  try {
    const items = JSON.parse(json) as unknown;
    if (!Array.isArray(items)) return [];
    return items
      .filter((m) => m && typeof m.name === "string" && typeof m.content === "string")
      .map((m) => ({ name: m.name, content: m.content }));
  } catch {
    return [];
  }
}

function badgesHtml(badges: ListingBadge[]): string {
  if (!badges.length) return "";
  return `<p class="badges">${badges
    .map((b) => `<a href="${e(b.href)}" rel="noopener"><img src="${e(b.img)}" alt="${e(b.alt)}" height="40"></a>`)
    .join(" ")}</p>`;
}

type SiteExtras = { badges: ListingBadge[]; meta: MetaTag[] };

export const siteExtras = (env: { LISTING_BADGES_JSON?: string; SITE_VERIFICATION_META_JSON?: string }): SiteExtras => ({
  badges: listingBadges(env.LISTING_BADGES_JSON),
  meta: verificationMeta(env.SITE_VERIFICATION_META_JSON),
});

function layout(title: string, description: string, body: string, extras: SiteExtras = { badges: [], meta: [] }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="text/markdown" href="/llms.txt" title="Agent docs">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI">
${extras.meta.map((m) => `<meta name="${e(m.name)}" content="${e(m.content)}">`).join("\n")}
<style>${STYLES}</style>
</head>
<body>
<header class="top"><div class="wrap">
<a class="brand" href="/"><img src="/icon.svg" alt="">${e(SERVICE_NAME)}</a>
<nav><a href="/docs">API reference</a><a href="/openapi.json">OpenAPI</a><a href="/llms.txt">llms.txt</a><a href="/.well-known/x402">x402</a></nav>
</div></header>
<main class="wrap">${body}</main>
<footer><div class="wrap">
Data is republished under its original licences; every response includes an <code>attribution</code> object.
Machine-readable: <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/.well-known/x402">x402 manifest</a> ·
<a href="/.well-known/mcp/server-card.json">MCP server card</a> · <a href="/v1/datasets">dataset catalog</a>
${badgesHtml(extras.badges)}
</div></footer>
</body>
</html>`;
}

const priceCell = (endpoint: Endpoint) =>
  endpoint.price ? `<span class="price">${e(endpoint.price)}</span>` : `<span class="price free">Free</span>`;

function endpointsTable(dataset: Dataset): string {
  const rows = dataset.endpoints
    .map(
      (ep) => `<tr>
<td><code>${e(ep.method)} ${e(endpointFullPath(dataset, ep))}</code><br><span class="muted">MCP: <code>${e(toolName(dataset, ep))}</code></span></td>
<td>${e(ep.summary)}</td>
<td class="price-cell">${priceCell(ep)}</td>
</tr>`
    )
    .join("");
  return `<div class="table-scroll"><table class="stack"><thead><tr><th>Endpoint / tool</th><th>What it does</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const formatTime = (iso: unknown) =>
  typeof iso === "string" ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "not yet";

function statsBlock(status: Record<string, unknown> | null): string {
  if (!status || "error" in status) return "";
  const backfill = status.backfill as { complete?: boolean; lodged_on_or_after?: string | null } | undefined;
  const coverage = backfill?.complete
    ? "Complete history"
    : backfill?.lodged_on_or_after
      ? `Lodged since ${backfill.lodged_on_or_after}`
      : "Backfill starting";
  const records = typeof status.records === "number" ? status.records.toLocaleString("en-AU") : "–";
  return `<div class="stats">
<div class="stat"><b>${e(records)}</b><span>records</span></div>
<div class="stat"><b>${e(formatTime(status.last_incremental_sync))}</b><span>last synced</span></div>
<div class="stat"><b>${e(coverage)}</b><span>coverage (history backfill in progress)</span></div>
</div>`;
}

// "a, b and c"
const listOf = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

// Plain-language summary for visitors who are not developers (e.g. arriving
// from a search engine), built from the registered datasets.
export function plainSummary(datasets: Dataset[]): string {
  const prices = datasets
    .flatMap((d) => d.endpoints.map((ep) => ep.price))
    .filter((p): p is `$${string}` => p !== undefined)
    .map((p) => Number(p.slice(1)))
    .sort((a, b) => a - b);
  // One example task per dataset that has prompts
  const examples = datasets
    .map((d) => d.prompts?.[0]?.title)
    .filter((t): t is string => Boolean(t))
    .map((t) => `“${t}”`);
  const cost = prices.length
    ? ` Each answer costs $${prices[0]} to $${prices[prices.length - 1]}, paid per call by the assistant (summaries are free, and MCP clients get up to ${MCP_FREE_CALLS_PER_DAY} free paid-tool calls a day).`
    : "";
  return `<div class="card plain"><p><b>In plain words:</b> connect this service to an AI assistant (such as Claude, ChatGPT or Cursor) and it can look up live ${e(
    listOf(datasets.map((d) => d.title))
  )} data for you${examples.length ? `, for example ${e(listOf(examples))}` : ""}.${cost} There is nothing to sign up for, and it is meant to be used by the assistant rather than in the browser.</p></div>`;
}

export async function homePage(datasets: Dataset[], c: Context<AppEnv>): Promise<string> {
  const origin = new URL(c.req.url).origin;
  const x402 = readX402Config(c.env);
  const network = x402 ? (NETWORK_LABELS[x402.network] ?? x402.network) : null;
  const entries = await catalog(datasets, c.env);
  const firstFree = datasets.flatMap((d) => d.endpoints.filter((ep) => !ep.price).map((ep) => endpointFullPath(d, ep)))[0];
  const firstPaid = datasets.flatMap((d) => d.endpoints.filter((ep) => ep.price).map((ep) => ({ d, ep })))[0];

  const datasetCards = datasets
    .map((dataset, i) => {
      const a = dataset.attribution;
      return `<div class="card">
<h3 style="margin-top:0">${e(dataset.title)}</h3>
<p>${e(dataset.description)}</p>
${statsBlock(entries[i].status as Record<string, unknown> | null)}
${endpointsTable(dataset)}
<p class="muted" style="margin-bottom:0">Source: ${e(a.publisher)} · <a href="${e(a.licenceUrl)}">${e(a.licence)}</a> · <a href="/docs#${e(dataset.id)}">Full reference</a></p>
</div>`;
    })
    .join("");

  const paidExample = firstPaid
    ? `<h3>Paid call (x402)</h3>
<p>Paid endpoints answer <code>402 Payment Required</code> with a <code>PAYMENT-REQUIRED</code> header. An x402 client pays in USDC${
        network ? ` on ${e(network)}` : ""
      } and retries automatically. No account, no API key.</p>
<pre><code>import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(KEY)) }],
});
const res = await pay("${e(origin)}${e(endpointFullPath(firstPaid.d, firstPaid.ep))}${
        firstPaid.ep.exampleInput ? `?${e(new URLSearchParams(firstPaid.ep.exampleInput).toString())}` : ""
      }");</code></pre>`
    : "";

  const body = `
<section class="hero">
<h1>On-chain data, ready for AI agents</h1>
<p>Clean, queryable data APIs that agents can discover and pay for on their own: pay per call with x402 in USDC${
    network ? ` on ${e(network)}` : ""
  }, no signup and no API key. Every endpoint is also an MCP tool.</p>
<div class="pills"><span class="pill">MCP server</span><span class="pill">x402 pay per call</span><span class="pill">OpenAPI 3.1</span><span class="pill">Free summary tier</span></div>
${plainSummary(datasets)}
</section>

<section>
<h2>Datasets</h2>
${datasetCards}
</section>

<section>
<h2>Quick start</h2>
<div class="card">
<h3 style="margin-top:0">Connect over MCP</h3>
<p>Add the server to any MCP client that supports remote (Streamable HTTP) servers:</p>
<pre><code>{
  "mcpServers": {
    "${e(SERVICE.mcpName)}": { "url": "${e(origin)}/mcp" }
  }
}</code></pre>
<p>Claude Code: <code>claude mcp add --transport http ${e(SERVICE.mcpName)} ${e(origin)}/mcp</code></p>
<p class="muted">Free tools work in every client, and every client gets ${MCP_FREE_CALLS_PER_DAY} free paid-tool calls per day while a shared daily allowance lasts. After that, paid tools need an x402-capable client (for example <code>@x402/mcp</code>); others receive the payment requirements as an error result.</p>
${firstFree ? `<h3>Free call</h3><pre><code>curl ${e(origin)}${e(firstFree)}</code></pre>` : ""}
${paidExample}
</div>
</section>

<section>
<h2>Missing data?</h2>
${missingDataCard(c.env.CONTACT_EMAIL, false)}
</section>

<section>
<h2>How payment works</h2>
<div class="card">
<ol class="steps">
<li>Call a paid endpoint or MCP tool without payment.</li>
<li>Receive the price, network and recipient (HTTP <code>402</code> with a <code>PAYMENT-REQUIRED</code> header, or an MCP error result).</li>
<li>Sign a USDC payment with your wallet and retry with the <code>PAYMENT-SIGNATURE</code> header (MCP: <code>_meta["x402/payment"]</code>).</li>
<li>Get the data. Settlement is confirmed in <code>PAYMENT-RESPONSE</code>. Calls that fail are not charged.</li>
</ol>
<p class="muted" style="margin-bottom:0">Payments settle through the Coinbase CDP facilitator; the platform never holds your funds.</p>
</div>
</section>`;

  return layout(
    `${SERVICE_NAME}: on-chain data for AI agents`,
    `${SERVICE.tagline}. Pay per call with x402, no signup. MCP server and OpenAPI included.`,
    body,
    siteExtras(c.env)
  );
}

export function docsPage(datasets: Dataset[], c: Context<AppEnv>): string {
  const origin = new URL(c.req.url).origin;
  const sections = datasets
    .map((dataset) => {
      const endpoints = dataset.endpoints
        .map((ep) => {
          const params = ep.params ?? [];
          const paramRows = params
            .map(
              (p) =>
                `<tr><td><code>${e(p.name)}</code></td><td>${p.in === "path" ? "path" : "query"}</td><td>${
                  p.required || p.in === "path" ? "yes" : "no"
                }</td><td>${e(p.description)}</td><td>${p.example ? `<code>${e(p.example)}</code>` : ""}</td></tr>`
            )
            .join("");
          return `<div class="card">
<h3 style="margin-top:0"><code>${e(ep.method)} ${e(endpointFullPath(dataset, ep))}</code></h3>
<p>${e(ep.summary)}${ep.details ? ` ${e(ep.details)}` : ""}</p>
<p><b>Price:</b> ${ep.price ? `${e(ep.price)} per call (x402, USDC)` : "free"} · <b>MCP tool:</b> <code>${e(toolName(dataset, ep))}</code></p>
${
  params.length
    ? `<div class="table-scroll"><table><thead><tr><th>Param</th><th>In</th><th>Required</th><th>Description</th><th>Example</th></tr></thead><tbody>${paramRows}</tbody></table></div>`
    : ""
}
</div>`;
        })
        .join("");
      const a = dataset.attribution;
      return `<section id="${e(dataset.id)}">
<h2>${e(dataset.title)}</h2>
<p>${e(dataset.description)}</p>
<p class="muted">Base path <code>/v1/${e(dataset.id)}</code> · Markdown: <a href="/docs/${e(dataset.id)}.md">/docs/${e(dataset.id)}.md</a></p>
${endpoints}
<p class="muted">Attribution: ${e(a.text)} <a href="${e(a.licenceUrl)}">Licence</a></p>
</section>`;
    })
    .join("");

  const body = `
<section class="hero" style="padding-bottom:8px">
<h1>API reference</h1>
<p>All responses are JSON: <code>{ data, meta, attribution }</code>. Base URL <code>${e(origin)}</code>. Paid endpoints use x402; see <a href="/">how payment works</a>.</p>
</section>
${sections}`;

  return layout(
    `API reference · ${SERVICE_NAME}`,
    "Endpoints, MCP tools, parameters and prices.",
    body,
    siteExtras(c.env)
  );
}

// How people and agents can ask for data that is not covered yet
function missingDataCard(contactEmail: string | undefined, heading: boolean): string {
  const email = contactEmail?.trim();
  return `<div class="card">
${heading ? '<h3 style="margin-top:0">Missing data?</h3>\n' : ""}<p style="margin:0">Tell us which data you need that is not here yet: ${e(SERVICE.requestExamples)}. Agents can use the free MCP tool <code>request_data</code>; scripts can <code>POST /v1/data-requests</code> with <code>{"request": "...", "use_case": "..."}</code>.${
    email ? ` Or email <a href="mailto:${e(email)}">${e(email)}</a>.` : ""
  }</p>
</div>`;
}

// Shown when a browser opens the MCP endpoint (e.g. from a shared link):
// how to connect an MCP client, instead of the transport's 406.
export function mcpPage(datasets: Dataset[], c: Context<AppEnv>): string {
  const origin = new URL(c.req.url).origin;
  const tools = datasets.flatMap((d) => d.endpoints.map((ep) => ({ name: toolName(d, ep), endpoint: ep })));
  const toolRows = tools
    .map((t) => `<tr><td><code>${e(t.name)}</code></td><td>${e(t.endpoint.summary)}</td><td class="price-cell">${priceCell(t.endpoint)}</td></tr>`)
    .join("");
  const body = `
<section class="hero">
<h1>MCP server</h1>
<p>This address is a remote MCP server (Streamable HTTP) for AI assistants, not a web page. Add it to an MCP client such as Claude, Cursor or Codex and the assistant can call the ${tools.length} tools below.</p>
<pre><code>${e(origin)}/mcp</code></pre>
</section>

<section>
<h2>Connect</h2>
<div class="card">
<p>Any client that supports remote MCP servers:</p>
<pre><code>{
  "mcpServers": {
    "${e(SERVICE.mcpName)}": { "url": "${e(origin)}/mcp" }
  }
}</code></pre>
<p>Claude Code: <code>claude mcp add --transport http ${e(SERVICE.mcpName)} ${e(origin)}/mcp</code></p>
<p class="muted" style="margin-bottom:0">No signup or API key. Free tools work in every client, and every client gets ${MCP_FREE_CALLS_PER_DAY} free paid-tool calls per day while a shared daily allowance lasts. After that, paid tools charge per call via x402.</p>
</div>
</section>

<section>
<h2>Tools</h2>
<div class="card">
<div class="table-scroll"><table class="stack"><thead><tr><th>Tool</th><th>What it does</th><th>Price</th></tr></thead><tbody>${toolRows}</tbody></table></div>
<p class="muted" style="margin-bottom:0">Prices, parameters and examples: <a href="/docs">API reference</a> · <a href="/">Home</a></p>
</div>
${missingDataCard(c.env.CONTACT_EMAIL, true)}
</section>`;

  return layout(`MCP server · ${SERVICE_NAME}`, "Connect an AI assistant to the remote MCP server.", body, siteExtras(c.env));
}

type PaymentRequirement = { network?: string; amount?: string; asset?: string; payTo?: string };

// Reads the first accepted payment option from the base64 JSON
// PAYMENT-REQUIRED header of an x402 v2 402 response.
export function paymentRequirement(header: string | null): PaymentRequirement | null {
  if (!header) return null;
  try {
    const decoded = JSON.parse(atob(header)) as { accepts?: PaymentRequirement[] };
    return decoded.accepts?.[0] ?? null;
  } catch {
    return null;
  }
}

const EXPLORERS: Record<string, string> = {
  "eip155:8453": "https://basescan.org/address/",
  "eip155:84532": "https://sepolia.basescan.org/address/",
};

// Shown when a browser opens a paid endpoint without paying: what the call
// costs, how it is paid and the free preview, in place of the x402 library's
// bare paywall page. Agents still get the JSON 402 and the same headers.
export function paymentRequiredPage(
  c: Context<AppEnv>,
  endpoint: Endpoint,
  requirement: PaymentRequirement | null,
  preview: Record<string, unknown> | null
): string {
  const network = requirement?.network ?? "";
  const networkLabel = NETWORK_LABELS[network] ?? network;
  const payTo = requirement?.payTo ?? "";
  const explorer = EXPLORERS[network];
  const payToHtml = payTo
    ? explorer
      ? `<a href="${e(explorer + payTo)}"><code>${e(payTo)}</code></a>`
      : `<code>${e(payTo)}</code>`
    : "";
  const rows = [
    ["Price", `<span class="price">${e(endpoint.price ?? "")}</span> per call, in USDC`],
    ["Network", e(networkLabel)],
    ["Paid to", payToHtml],
    ["Protocol", `<a href="https://www.x402.org">x402</a>: no signup or API key; the agent pays and retries`],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`)
    .join("");
  const previewHtml = preview
    ? `<div class="card">
<h3 style="margin-top:0">Free preview</h3>
<p class="muted">What this call would return, shown before paying:</p>
<pre><code>${e(JSON.stringify(preview, null, 2))}</code></pre>
</div>`
    : "";
  const body = `
<section class="hero">
<h1>Payment required: ${e(endpoint.price ?? "")} per call</h1>
<p>${e(endpoint.summary)} This is a paid API endpoint for AI agents and scripts. They pay per call with x402, in USDC on ${e(networkLabel || "Base")}.</p>
</section>

<section>
<div class="card">
<div class="table-scroll"><table>${rows}</table></div>
</div>
${previewHtml}
<div class="card">
<h3 style="margin-top:0">How an agent pays</h3>
<ol style="margin:0;padding-left:20px">
<li>It calls this URL and gets HTTP 402 with the payment terms in the <code>PAYMENT-REQUIRED</code> header.</li>
<li>It signs a USDC payment for that amount with its wallet.</li>
<li>It retries with the <code>PAYMENT-SIGNATURE</code> header and gets the data. Failed calls are never charged.</li>
</ol>
<p class="muted" style="margin-bottom:0">Use it from an AI assistant via the <a href="/mcp">MCP server</a>, or see the <a href="/docs">API reference</a>.</p>
</div>
</section>`;

  return layout(
    `Payment required · ${SERVICE_NAME}`,
    `${endpoint.summary} Paid per call with x402.`,
    body,
    siteExtras(c.env)
  );
}
