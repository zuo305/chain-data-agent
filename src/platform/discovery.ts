import { SERVICE } from "../service";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../types";
import { type Dataset, datasetBasePath, endpointFullPath, toolName } from "./dataset";
import { docsPage, homePage } from "./site";
import { MCP_FREE_CALLS_PER_DAY, MCP_FREE_CALLS_PER_TOOL_PER_DAY } from "./freecalls";

// Agent-facing docs are generated from dataset definitions so they never
// drift from the actual routes and prices.

async function datasetStatus(dataset: Dataset, env: Bindings) {
  if (!dataset.status) return null;
  try {
    return await dataset.status(env);
  } catch (err) {
    console.error(`Status failed for ${dataset.id}`, err);
    return { error: "status_unavailable" };
  }
}

export async function catalog(datasets: Dataset[], env: Bindings) {
  return Promise.all(
    datasets.map(async (dataset) => ({
      id: dataset.id,
      title: dataset.title,
      description: dataset.description,
      base_path: datasetBasePath(dataset),
      attribution: dataset.attribution,
      status: await datasetStatus(dataset, env),
      endpoints: dataset.endpoints.map((e) => ({
        method: e.method,
        path: endpointFullPath(dataset, e),
        mcp_tool: toolName(dataset, e),
        summary: e.summary,
        price_usd: e.price ?? "free",
        params: e.params ?? [],
      })),
    }))
  );
}

// Price range of the paid endpoints, e.g. "$0.005 to $0.05"
function priceRange(datasets: Dataset[]): string | null {
  const prices = datasets
    .flatMap((d) => d.endpoints.map((e) => e.price))
    .filter((p): p is `$${string}` => p !== undefined)
    .map((p) => Number(p.slice(1)))
    .sort((a, b) => a - b);
  if (prices.length === 0) return null;
  return prices[0] === prices[prices.length - 1] ? `$${prices[0]}` : `$${prices[0]} to $${prices[prices.length - 1]}`;
}

// The questions an assistant can answer with these tools, from the dataset
// prompts, so an assistant reading this file on a user's behalf can tell
// whether the service fits the question it was asked.
function questionLines(datasets: Dataset[]): string[] {
  const prompts = datasets.flatMap((d) => (d.prompts ?? []).map((p) => `- ${p.title}: ${p.description}`));
  return prompts.length ? ["## Questions this answers", ...prompts, ""] : [];
}

export function llmsTxt(datasets: Dataset[], origin = ""): string {
  const prices = priceRange(datasets);
  const lines = [
    `# ${SERVICE.name}`,
    "",
    `> ${SERVICE.tagline}.`,
    "> Paid endpoints use x402: call the endpoint, receive HTTP 402 with payment",
    "> requirements, retry with a PAYMENT-SIGNATURE header. No signup or API key.",
    "",
    `Data covered: ${datasets.map((d) => d.title).join(", ")}.`,
    "",
    ...questionLines(datasets),
    "## Use it from an AI assistant",
    `Add the remote MCP server \`${origin}/mcp\` to an assistant that supports MCP connectors`,
    "(Claude, ChatGPT, Cursor, Codex and others), then ask in plain language. There is",
    "nothing to sign up for. Summary tools are free, and each client gets",
    `${MCP_FREE_CALLS_PER_DAY} free paid-tool calls a day${prices ? `; after that a call costs ${prices} in USDC via x402` : ""}.`,
    "",
    "## Docs",
    "- [API overview](/docs/index.md): datasets, endpoints, prices, attribution",
    "- [Dataset catalog](/v1/datasets): machine-readable JSON catalog",
    "- [OpenAPI spec](/openapi.json): every endpoint, with x402 prices in `x-x402`",
    "- [x402 manifest](/.well-known/x402): paid resources with full payment details",
    "- [MCP server](/mcp): Streamable HTTP MCP endpoint; every endpoint is also a tool,",
    "  paid tools use the x402 MCP transport (`_meta[\"x402/payment\"]`)",
    "- Missing data? The free MCP tool `request_data`, or POST /v1/data-requests with",
    "  `{\"request\": \"...\", \"use_case\": \"...\"}`, tells the maintainers what you need",
    "",
    "## Datasets",
  ];
  for (const dataset of datasets) {
    lines.push(`- [${dataset.title}](/docs/${dataset.id}.md): ${dataset.description}`);
  }
  return lines.join("\n") + "\n";
}

export function datasetMarkdown(dataset: Dataset): string {
  const lines = [`# ${dataset.title}`, "", dataset.description, "", "## Endpoints", ""];
  for (const e of dataset.endpoints) {
    lines.push(`### ${e.method} ${endpointFullPath(dataset, e)}`, "", e.summary, "");
    if (e.details) lines.push(e.details, "");
    lines.push(`MCP tool: \`${toolName(dataset, e)}\``, "");
    lines.push(`Price: ${e.price ? `${e.price} per call (x402, USDC)` : "free"}`, "");
    if (e.params?.length) {
      lines.push("| Param | Required | Description | Example |", "|---|---|---|---|");
      for (const p of e.params) {
        lines.push(`| ${p.name} | ${p.required ? "yes" : "no"} | ${p.description} | ${p.example ?? ""} |`);
      }
      lines.push("");
    }
  }
  lines.push("## Attribution", "", `${dataset.attribution.text} Licence: ${dataset.attribution.licenceUrl}`, "");
  return lines.join("\n");
}

export function docsIndexMarkdown(datasets: Dataset[]): string {
  return [
    "# API overview",
    "",
    "All responses are JSON: `{ data, meta, attribution }`.",
    "",
    "## Payment (x402)",
    "",
    "Paid endpoints return HTTP 402 with a `PAYMENT-REQUIRED` header describing the price,",
    "network and recipient. Pay with an x402 client (e.g. `@x402/fetch`) and retry with the",
    "`PAYMENT-SIGNATURE` header. Settlement details come back in `PAYMENT-RESPONSE`.",
    "",
    "The unpaid 402 body may include a free `preview`: how many records the call would",
    "return, or an input error to fix before paying (`valid: false`). Check it before paying.",
    "",
    "## MCP",
    "",
    "`POST /mcp` is a stateless Streamable HTTP MCP server. Each endpoint below is also a tool.",
    `Each client gets ${MCP_FREE_CALLS_PER_DAY} free paid-tool calls per day (marked in \`meta.free_call\`), while a`,
    `shared allowance of ${MCP_FREE_CALLS_PER_TOOL_PER_DAY} free calls per tool per day lasts.`,
    "After that, paid tools return the x402 payment requirements as an error result; x402-capable",
    "MCP clients (e.g. `@x402/mcp`) pay and retry automatically.",
    "",
    "## Datasets",
    "",
    ...datasets.map((d) => `- [${d.title}](/docs/${d.id}.md) — base path \`${datasetBasePath(d)}\``),
    "",
  ].join("\n");
}


const MARKDOWN = { "Content-Type": "text/markdown; charset=utf-8" };

export function discoveryRoutes(datasets: Dataset[]): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const index = docsIndexMarkdown(datasets);

  app.get("/llms.txt", (c) => c.text(llmsTxt(datasets, new URL(c.req.url).origin), 200, MARKDOWN));
  app.get("/v1/datasets", async (c) => c.json({ data: await catalog(datasets, c.env) }));
  app.get("/docs/index.md", (c) => c.text(index, 200, MARKDOWN));

  app.get("/docs/:file{.+\\.md}", (c) => {
    const dataset = byId.get(c.req.param("file").replace(/\.md$/, ""));
    if (!dataset) return c.json({ error: "not_found" }, 404);
    return c.text(datasetMarkdown(dataset), 200, MARKDOWN);
  });

  // Same URL, two representations: markdown for agents, HTML for browsers
  app.get("/docs", (c) => {
    if (c.get("wantsMarkdown")) return c.text(index, 200, { ...MARKDOWN, Vary: "Accept" });
    return c.html(docsPage(datasets, c), 200, { Vary: "Accept" });
  });

  // Home: HTML for browsers, the JSON service index for everything else
  app.get("/", async (c) => {
    if ((c.req.header("Accept") ?? "").includes("text/html")) {
      return c.html(await homePage(datasets, c), 200, { Vary: "Accept" });
    }
    return c.json(
      {
        name: SERVICE.mcpName,
        datasets: "/v1/datasets",
        mcp: "/mcp",
        openapi: "/openapi.json",
        x402: "/.well-known/x402",
        docs: "/docs",
        llms: "/llms.txt",
      },
      200,
      { Vary: "Accept" }
    );
  });

  return app;
}
