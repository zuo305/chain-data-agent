import { SERVICE } from "../service";
import { Hono, type Context, type Handler } from "hono";
import type { AppEnv, Bindings } from "../types";

// Contract every dataset implements to plug into the platform.
// The platform derives routing, x402 pricing, discovery docs and the
// catalog from these definitions, so adding a dataset never touches
// platform code beyond registering it in registry.ts.

export type HttpMethod = "GET" | "POST";

export type Param = {
  name: string;
  description: string;
  // "path" params fill ":name" segments of the endpoint path
  in?: "query" | "path";
  required?: boolean;
  example?: string;
};

export type Endpoint = {
  method: HttpMethod;
  // Path relative to the dataset base, Hono syntax, e.g. "/applications/:pan"
  path: string;
  // MCP tool name, unique within the dataset, e.g. "search_applications"
  toolName: string;
  // One verb-first sentence: what the endpoint does
  summary: string;
  // When to use it, what it returns, limits and errors (shown to agents in
  // MCP tool descriptions)
  details?: string;
  // USD price per call, e.g. "$0.01". Omit for free endpoints.
  price?: `$${string}`;
  params?: Param[];
  // Example call and response, published to x402 Bazaar discovery. Without
  // exampleInput, every param's example is used, which may combine filters
  // into a query that matches nothing.
  exampleInput?: Record<string, string>;
  outputExample?: unknown;
  // Source of this endpoint's data when it differs from the dataset's (named
  // in tool descriptions)
  attribution?: Attribution;
  handler: (c: Context<AppEnv>) => Response | Promise<Response>;
  // Paid endpoints only: a free, cheap hint added to the 402 response so an
  // agent can see what it would get (e.g. how many records match) before it
  // pays. Must stay bounded, since every unpaid request runs it. Path params
  // are passed in because the 402 is sent before routing.
  preview?: (c: Context<AppEnv>, params: Record<string, string>) => Promise<Record<string, unknown> | null>;
};

export type Attribution = {
  publisher: string;
  licence: string;
  licenceUrl: string;
  text: string;
};

export type PromptArg = { name: string; description: string; required?: boolean };

// Reusable MCP prompt: a ready-made task that tells the agent which tools to call
export type DatasetPrompt = {
  name: string;
  title: string;
  description: string;
  args: PromptArg[];
  text: (args: Record<string, string | undefined>) => string;
};

export type Dataset = {
  // URL-safe id, used as the base path: /v1/<id>
  id: string;
  title: string;
  description: string;
  attribution: Attribution;
  // Up to 5 short discovery tags (x402 Bazaar), e.g. ["solana", "validators"]
  tags?: string[];
  endpoints: Endpoint[];
  prompts?: DatasetPrompt[];
  // Called from the cron trigger to keep the dataset fresh.
  sync?: (env: Bindings) => Promise<unknown>;
  // Freshness and coverage, shown in the catalog.
  status?: (env: Bindings) => Promise<Record<string, unknown>>;
};

export const API_PREFIX = "/v1";

export function datasetBasePath(dataset: Dataset): string {
  return `${API_PREFIX}/${dataset.id}`;
}

// MCP tool / OpenAPI operation id: "<dataset id>_<endpoint toolName>"
export function toolNameFor(datasetId: string, endpointToolName: string): string {
  return `${datasetId.replace(/-/g, "_")}_${endpointToolName}`;
}

export function toolName(dataset: Dataset, endpoint: Endpoint): string {
  return toolNameFor(dataset.id, endpoint.toolName);
}

export function endpointFullPath(dataset: Dataset, endpoint: Endpoint): string {
  return `${datasetBasePath(dataset)}${endpoint.path}`;
}

// Name shown for paid resources in x402 Bazaar (max 32 printable ASCII chars)
export const SERVICE_NAME = SERVICE.name;

type JsonSchemaObject = { type: "object"; properties: Record<string, unknown>; required: string[] };

function paramSchema(params: Param[]): JsonSchemaObject {
  return {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p.name, { type: "string", description: p.description }])),
    required: params.filter((p) => p.required).map((p) => p.name),
  };
}

function paramExamples(params: Param[]): Record<string, string> {
  return Object.fromEntries(params.filter((p) => p.example !== undefined).map((p) => [p.name, p.example!]));
}

// Query/path params of an endpoint as JSON schemas with example values,
// shared by the x402 Bazaar declarations for HTTP routes and MCP tools.
export function endpointInputs(endpoint: Endpoint) {
  const params = endpoint.params ?? [];
  const query = params.filter((p) => p.in !== "path");
  const path = params.filter((p) => p.in === "path");
  const pick = (subset: Param[]) =>
    endpoint.exampleInput
      ? Object.fromEntries(subset.filter((p) => p.name in endpoint.exampleInput!).map((p) => [p.name, endpoint.exampleInput![p.name]]))
      : paramExamples(subset);
  return {
    query: { schema: paramSchema(query), example: pick(query) },
    path: { schema: paramSchema(path), example: pick(path) },
    all: { schema: paramSchema(params), example: pick(params) },
  };
}

export function isPaid(endpoint: Endpoint): boolean {
  return endpoint.price !== undefined;
}

// Mounts every endpoint of every dataset onto the app.
export function mountDatasets(app: Hono<AppEnv>, datasets: Dataset[]): void {
  for (const dataset of datasets) {
    for (const endpoint of dataset.endpoints) {
      const path = endpointFullPath(dataset, endpoint);
      if (endpoint.method === "GET") {
        app.get(path, endpoint.handler);
        if (!isPaid(endpoint)) app.post(path, postAsGet(path, endpoint.handler));
      } else app.post(path, endpoint.handler);
    }
  }
}

// Some agents POST by default. Free GET endpoints also accept POST with their
// params as a JSON or form body, re-dispatched as a GET with a query string.
// Paid endpoints stay GET-only so x402 has a single route per price to guard.
function postAsGet(path: string, handler: Handler<AppEnv>): Handler<AppEnv> {
  const inner = new Hono<AppEnv>().get(path, handler);
  return async (c) => {
    const params = await readBodyParams(c);
    if (typeof params === "string") return badRequest(c, params);
    const url = new URL(c.req.url);
    for (const [name, value] of Object.entries(params)) {
      if (!url.searchParams.has(name)) url.searchParams.set(name, value);
    }
    let ctx: typeof c.executionCtx | undefined;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = undefined; // not available outside the Workers runtime (tests)
    }
    return inner.fetch(new Request(url, { method: "GET", headers: c.req.raw.headers }), c.env, ctx);
  };
}

// Flat string params from a JSON or form body; an empty body has none.
async function readBodyParams(c: Context<AppEnv>): Promise<Record<string, string> | string> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  const type = c.req.header("Content-Type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "Body must be a JSON object of query parameters, or use GET with a query string.";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Body must be a JSON object of query parameters, or use GET with a query string.";
  }
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      params[name] = String(value);
    }
  }
  return params;
}

// Runs every dataset's sync; one failing dataset does not stop the others.
export async function syncDatasets(datasets: Dataset[], env: Bindings): Promise<void> {
  for (const dataset of datasets) {
    if (!dataset.sync) continue;
    try {
      await dataset.sync(env);
    } catch (err) {
      console.error(`Sync failed for ${dataset.id}`, err);
    }
  }
}

// Standard success envelope so agents see the same shape for every dataset.
export function dataResponse<T>(
  c: Context<AppEnv>,
  dataset: Dataset,
  data: T,
  meta: Record<string, unknown> = {}
): Response {
  return c.json({ data, meta, attribution: dataset.attribution });
}

export function badRequest(c: Context<AppEnv>, message: string): Response {
  return c.json({ error: "bad_request", message }, 400);
}
