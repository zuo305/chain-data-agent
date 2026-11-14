import { SERVICE } from "../service";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { dataRequestToolCard } from "./requests";
import { type Dataset, SERVICE_NAME, endpointFullPath, isPaid, toolName } from "./dataset";
import {
  INSTRUCTIONS,
  SERVER_INFO,
  TOOL_ANNOTATIONS,
  mcpResources,
  toolDescription,
  toolInputJsonSchema,
  toolOutputJsonSchema,
} from "./mcp";
import { openApiDocument } from "./openapi";
import { readX402Config } from "./x402";

// Machine-readable discovery files that agents and directories probe for
// (seen in usage_log as 404s). All are generated from dataset definitions.

// USDC contract per network, used to give complete payment info in the x402 manifest
const USDC: Record<string, string> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const usdToAtomic = (price: string) => String(Math.round(Number(price.replace("$", "")) * 1_000_000));

const origin = (c: Context<AppEnv>) => new URL(c.req.url).origin;

// Public, cacheable and readable cross-origin
const PUBLIC_HEADERS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" };

// x402 resource-server manifest, following the draft discovery extension
// (x402-foundation/x402 PR #2979). The live 402 response stays authoritative.
export function x402Manifest(datasets: Dataset[], c: Context<AppEnv>) {
  const config = readX402Config(c.env);
  const base = origin(c);
  const resources = datasets.flatMap((dataset) =>
    dataset.endpoints.filter(isPaid).map((endpoint) => {
      const url = `${base}${endpointFullPath(dataset, endpoint)}`;
      const asset = config ? USDC[config.network] : undefined;
      // Entries are either complete or bare URLs, never partial
      if (!config || !asset) return { url };
      return {
        url,
        method: endpoint.method,
        description: `${dataset.title}: ${endpoint.summary}`,
        mimeType: "application/json",
        scheme: "exact",
        network: config.network,
        asset,
        amount: usdToAtomic(endpoint.price!),
        price: endpoint.price,
        payTo: config.payTo,
      };
    })
  );
  return {
    x402Version: 2,
    kind: "resource-server",
    name: SERVICE_NAME,
    description: `${SERVICE.tagline}, paid per call via x402.`,
    docs: `${base}/llms.txt`,
    openapi: `${base}/openapi.json`,
    mcp: `${base}/mcp`,
    resources,
  };
}

// MCP server card (served at every commonly probed path)
export function mcpServerCard(datasets: Dataset[], c: Context<AppEnv>) {
  return {
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    transport: { type: "streamable-http", url: `${origin(c)}/mcp` },
    authentication: { required: false },
    tools: [
      ...datasets.flatMap((dataset) =>
        dataset.endpoints.map((endpoint) => ({
          name: toolName(dataset, endpoint),
          description: toolDescription(dataset, endpoint),
          inputSchema: toolInputJsonSchema(endpoint),
          outputSchema: toolOutputJsonSchema(),
          annotations: { ...TOOL_ANNOTATIONS, title: endpoint.summary },
        }))
      ),
      dataRequestToolCard(),
    ],
    resources: mcpResources(datasets, origin(c)).map(({ uri, name, title, description, mimeType }) => ({
      uri,
      name,
      title,
      description,
      mimeType,
    })),
    prompts: datasets.flatMap((dataset) =>
      (dataset.prompts ?? []).map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
        arguments: p.args,
      }))
    ),
  };
}

// A2A agent card (a2a-protocol.org). The service does not speak A2A: the card
// lists the tools as skills for directories that index A2A cards, and points
// callers at MCP and the REST API.
export function a2aAgentCard(datasets: Dataset[], c: Context<AppEnv>) {
  const base = origin(c);
  return {
    protocolVersion: "0.3.0",
    name: SERVICE_NAME,
    description:
      `${SERVER_INFO.description} Not an A2A task endpoint: call the skills as MCP tools at ${base}/mcp ` +
      `or as REST endpoints (${base}/openapi.json).`,
    url: `${base}/mcp`,
    version: SERVER_INFO.version,
    documentationUrl: `${base}/llms.txt`,
    iconUrl: `${base}/icon.svg`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: datasets.flatMap((dataset) =>
      dataset.endpoints.map((endpoint) => ({
        id: toolName(dataset, endpoint),
        name: endpoint.summary,
        description: toolDescription(dataset, endpoint),
        tags: [dataset.id, isPaid(endpoint) ? "x402" : "free"],
      }))
    ),
  };
}

// agents.json (wild-card-ai/agents-json): one single-action flow per operation
export function agentsJson(datasets: Dataset[], c: Context<AppEnv>) {
  const sourceId = SERVICE.mcpName.replace(/-/g, "_");
  return {
    agentsJson: "0.1.0",
    info: {
      title: SERVICE_NAME,
      version: "0.1.0",
      description: `${SERVICE.tagline}. Paid operations use x402 (USDC).`,
    },
    sources: [{ id: sourceId, path: `${origin(c)}/openapi.json` }],
    overrides: [],
    flows: datasets.flatMap((dataset) =>
      dataset.endpoints.map((endpoint) => {
        const id = toolName(dataset, endpoint);
        return {
          id,
          title: endpoint.summary,
          description: toolDescription(dataset, endpoint),
          actions: [{ id: `${id}_action`, sourceId, operationId: id }],
          links: [],
          fields: {
            parameters: (endpoint.params ?? []).map((p) => ({
              name: p.name,
              description: p.description,
              required: p.in === "path" || Boolean(p.required),
              type: "string",
            })),
            responses: { success: { type: "object" } },
          },
        };
      })
    ),
  };
}

function robotsTxt(c: Context<AppEnv>): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin/",
    "",
    "# Agent docs: /llms.txt, API: /openapi.json, MCP: /mcp, x402: /.well-known/x402",
    `Sitemap: ${origin(c)}/sitemap.xml`,
    "",
  ].join("\n");
}

function sitemapXml(datasets: Dataset[], c: Context<AppEnv>): string {
  const base = origin(c);
  const urls = ["/", "/docs", "/docs/index.md", "/llms.txt", "/openapi.json", "/v1/datasets"].concat(
    datasets.map((d) => `/docs/${d.id}.md`)
  );
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${base}${u}</loc></url>`).join("\n") +
    "\n</urlset>\n"
  );
}

// Simple icon: a map pin over a grid, in the platform's accent colour
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#0f766e"/>
<path d="M14 44h36M14 34h36M24 20v32M40 20v32" stroke="#99f6e4" stroke-width="2" opacity=".6"/>
<path d="M32 10c-7.7 0-14 6-14 13.6C18 34 32 50 32 50s14-16 14-26.4C46 16 39.7 10 32 10z" fill="#fff"/>
<circle cx="32" cy="23.5" r="5" fill="#0f766e"/>
</svg>`;

export function wellKnownRoutes(datasets: Dataset[]): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const openapi = (c: Context<AppEnv>) => c.json(openApiDocument(datasets, c.env, origin(c)), 200, PUBLIC_HEADERS);
  app.get("/openapi.json", openapi);
  app.get("/swagger.json", openapi);

  const x402 = (c: Context<AppEnv>) => c.json(x402Manifest(datasets, c), 200, PUBLIC_HEADERS);
  app.get("/.well-known/x402", x402);
  app.get("/.well-known/x402.json", x402);

  const card = (c: Context<AppEnv>) => c.json(mcpServerCard(datasets, c), 200, PUBLIC_HEADERS);
  app.get("/.well-known/mcp/server-card.json", card);
  app.get("/.well-known/mcp.json", card);
  app.get("/.well-known/mcp", card);
  app.get("/mcp/server-card", card);

  const a2a = (c: Context<AppEnv>) => c.json(a2aAgentCard(datasets, c), 200, PUBLIC_HEADERS);
  app.get("/.well-known/agent-card.json", a2a);
  app.get("/.well-known/agent.json", a2a);

  const agents = (c: Context<AppEnv>) => c.json(agentsJson(datasets, c), 200, PUBLIC_HEADERS);
  app.get("/agents.json", agents);
  app.get("/.well-known/agents.json", agents);

  // Glama connector claim: Glama issues the file content, served verbatim
  app.get("/.well-known/glama.json", (c) => {
    const claim = c.env.GLAMA_CONNECTOR_JSON?.trim();
    if (!claim) return c.json({ error: "not_found" }, 404);
    return c.body(claim, 200, { "Content-Type": "application/json", ...PUBLIC_HEADERS });
  });

  // 402 Index domain verification: serves the hash 402index.io issued
  app.get("/.well-known/402index-verify.txt", (c) => {
    const hash = c.env.INDEX402_VERIFY_HASH?.trim();
    if (!hash) return c.json({ error: "not_found" }, 404);
    return c.text(hash, 200, PUBLIC_HEADERS);
  });

  app.get("/robots.txt", (c) => c.text(robotsTxt(c), 200, PUBLIC_HEADERS));
  app.get("/sitemap.xml", (c) =>
    c.body(sitemapXml(datasets, c), 200, { "Content-Type": "application/xml", ...PUBLIC_HEADERS })
  );

  const icon = (c: Context<AppEnv>) =>
    c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
  app.get("/favicon.ico", icon);
  app.get("/favicon.svg", icon);
  app.get("/icon.svg", icon);

  return app;
}
