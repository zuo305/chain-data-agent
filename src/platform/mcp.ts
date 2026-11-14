import { BASE_URL, SERVICE } from "../service";
import { Hono, type Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPaymentWrapper } from "@x402/mcp";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AppEnv } from "../types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  type Dataset,
  type Endpoint,
  SERVICE_NAME,
  endpointFullPath,
  endpointInputs,
  isPaid,
  mountDatasets,
  toolName,
} from "./dataset";
import { datasetMarkdown, llmsTxt } from "./discovery";
import { mcpPage } from "./site";
import {
  DATA_REQUEST_ANNOTATIONS,
  DATA_REQUEST_DESCRIPTION,
  DATA_REQUEST_TITLE,
  DATA_REQUEST_TOOL,
  dataRequestInputShape,
  recordDataRequest,
} from "./requests";

export { toolName };
import { type X402Config, configKey, initializedResourceServer, paymentExtensions, readX402Config } from "./x402";
import { MCP_FREE_CALLS_PER_DAY, freeCallClient, freeCallsUsed, hasFreeCall, recordFreeCall, utcDay } from "./freecalls";

// MCP server (Streamable HTTP, stateless) exposing every dataset endpoint as
// a tool. Tools are generated from dataset definitions, call the same
// handlers as the REST API, and paid tools charge via the x402 MCP transport
// (payment in _meta["x402/payment"], settlement in _meta["x402/payment-response"]).

export const SERVER_INFO = {
  name: SERVICE.mcpName,
  title: SERVICE.mcpTitle,
  version: SERVICE.version,
  description: SERVICE.description,
  websiteUrl: `${BASE_URL}/`,
  icons: [
    {
      src: `${BASE_URL}/icon.svg`,
      mimeType: "image/svg+xml",
      sizes: ["any"],
    },
  ],
};

// Every tool only reads public data; repeating a call has no side effects
// (paid calls charge each time, which is expected).
export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const INSTRUCTIONS =
  `Start with ${SERVICE.firstTool} (free) to see coverage. Each client gets ` +
  `${MCP_FREE_CALLS_PER_DAY} free paid-tool calls per day; after that, paid tools return x402 ` +
  "payment requirements as an error result, and x402-capable clients pay automatically and retry. " +
  "Every result includes an attribution object that must be kept when the data is shown. " +
  `If the data a task needs is not covered, ${DATA_REQUEST_TOOL} (free) passes the request on to the maintainers.`;

type ToolResult = {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function toolDescription(dataset: Dataset, endpoint: Endpoint): string {
  const source = endpoint.attribution ?? dataset.attribution;
  const price = endpoint.price
    ? `Costs ${endpoint.price} per call, paid via x402 in USDC on Base; the first ${MCP_FREE_CALLS_PER_DAY} ` +
      "paid-tool calls per day are free for MCP clients while a shared daily allowance lasts. Without x402 " +
      "support, later calls return the payment requirements as an error result. Failed calls are not charged."
    : "Free, no payment needed.";
  return [endpoint.summary, endpoint.details, price, `Source: ${source.publisher}, ${source.licence}.`]
    .filter(Boolean)
    .join(" ");
}

// The CDP facilitator lists MCP tools only with descriptions of at most 500
// characters (every MCP tool in the Bazaar is within it) and fails paid MCP
// calls with longer ones, so payment requirements and Bazaar metadata carry
// this shorter form; tools/list keeps the full description.
export const PAYMENT_DESCRIPTION_MAX = 500;

export function paymentDescription(dataset: Dataset, endpoint: Endpoint): string {
  const source = endpoint.attribution ?? dataset.attribution;
  const tail = ` Costs ${endpoint.price} per call (x402, USDC on Base). Source: ${source.publisher}, ${source.licence}.`;
  const budget = PAYMENT_DESCRIPTION_MAX - tail.length;
  // Whole sentences of summary and details that fit before the price and source
  let body = "";
  // A sentence ends at . ! or ? followed by a space and a capital letter, so
  // "e.g. '5A Atkins Rd'" and "meta.geocode" do not split
  for (const sentence of `${endpoint.summary} ${endpoint.details ?? ""}`.trim().split(/(?<=[.!?])\s+(?=[A-Z])/)) {
    const next = body ? `${body} ${sentence}` : sentence;
    if (next.length > budget) break;
    body = next;
  }
  if (!body) body = endpoint.summary.slice(0, budget);
  return `${body}${tail}`.slice(0, PAYMENT_DESCRIPTION_MAX);
}

// Read-only documentation exposed as MCP resources
export function mcpResources(datasets: Dataset[], origin: string) {
  return [
    {
      uri: `${origin}/llms.txt`,
      name: "llms_txt",
      title: "Platform overview for agents",
      description: "What the platform offers, how payment works and where the docs are.",
      mimeType: "text/markdown",
      text: () => llmsTxt(datasets, origin),
    },
    ...datasets.map((dataset) => ({
      uri: `${origin}/docs/${dataset.id}.md`,
      name: `${dataset.id.replace(/-/g, "_")}_docs`,
      title: `${dataset.title}: documentation`,
      description: `Endpoints, MCP tools, parameters, prices and attribution for ${dataset.title}.`,
      mimeType: "text/markdown",
      text: () => datasetMarkdown(dataset),
    })),
  ];
}

function inputShape(endpoint: Endpoint): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of endpoint.params ?? []) {
    // Agents often send numbers for numeric params; toolRequestPath stringifies them
    const field = z
      .union([z.string(), z.number()])
      .describe(p.example ? `${p.description} (e.g. ${p.example})` : p.description);
    shape[p.name] = p.required ? field : field.optional();
  }
  return shape;
}

// JSON schema of a tool's input, matching what the SDK publishes in tools/list
export function toolInputJsonSchema(endpoint: Endpoint) {
  const params = endpoint.params ?? [];
  return {
    type: "object",
    properties: Object.fromEntries(
      params.map((p) => [
        p.name,
        {
          anyOf: [{ type: "string" }, { type: "number" }],
          description: p.example ? `${p.description} (e.g. ${p.example})` : p.description,
        },
      ])
    ),
    required: params.filter((p) => p.required).map((p) => p.name),
  };
}

// Builds the REST URL for a tool call: path params fill ":name", the rest go
// into the query string.
export function toolRequestPath(dataset: Dataset, endpoint: Endpoint, args: Record<string, unknown>): string {
  const query = new URLSearchParams();
  let path = endpointFullPath(dataset, endpoint);
  for (const p of endpoint.params ?? []) {
    const value = args[p.name];
    if (value === undefined || value === null || value === "") continue;
    if (p.in === "path") path = path.replace(`:${p.name}`, encodeURIComponent(String(value)));
    else query.set(p.name, String(value));
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

// Every successful tool result is the REST envelope { data, meta, attribution },
// returned both as text and as structuredContent matching this schema.
export const OUTPUT_SHAPE = {
  data: z
    .unknown()
    .describe("Result: a list of applications for search and nearby tools, one record or summary object otherwise"),
  meta: z.record(z.unknown()).describe("Paging and query details, e.g. limit, offset, has_more, count"),
  attribution: z
    .object({
      publisher: z.string(),
      licence: z.string(),
      licenceUrl: z.string(),
      text: z.string().describe("Attribution text to show alongside the data"),
    })
    .describe("Source attribution; keep it when presenting the data"),
};

// JSON schema of OUTPUT_SHAPE, as published in tools/list (for static server cards)
export function toolOutputJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(z.object(OUTPUT_SHAPE)) as Record<string, unknown>;
}

function textResult(body: unknown, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text: JSON.stringify(body) }], isError };
  if (!isError && body && typeof body === "object") result.structuredContent = body as Record<string, unknown>;
  return result;
}

// Serves a paid tool call for free while the client and the tool's shared
// daily cap both have free calls left. Returns null when payment is needed.
// Only successful calls use up a free call.
async function freeCall(c: Context<AppEnv>, toolName: string, run: () => Promise<ToolResult>): Promise<ToolResult | null> {
  const day = utcDay();
  const client = await freeCallClient(c.req.header("CF-Connecting-IP"), day);
  const usedNow = await freeCallsUsed(c.env.DB, day, client, toolName);
  if (!hasFreeCall(usedNow)) return null;
  const used = usedNow.client;
  const result = await run();
  if (result.isError) return result;
  await recordFreeCall(c.env.DB, day, client, toolName);
  c.set("logDetail", `${c.get("logDetail") ?? "tools/call"} [free]`);
  const body = result.structuredContent as { meta?: Record<string, unknown> } | undefined;
  if (!body) return result;
  const remaining = MCP_FREE_CALLS_PER_DAY - used - 1;
  const meta = {
    ...body.meta,
    free_call: {
      remaining_today: remaining,
      limit_per_day: MCP_FREE_CALLS_PER_DAY,
      note:
        remaining > 0
          ? "This paid tool call was free."
          : "This was the last free paid-tool call today; further calls are paid per call via x402 (USDC on Base).",
    },
  };
  return textResult({ ...body, meta });
}

// Payment wrappers are built on first use of a price and cached per isolate,
// so listing tools never contacts the facilitator.
const wrappers = new Map<string, Promise<ReturnType<typeof createPaymentWrapper>>>();

function paymentWrapper(config: X402Config, dataset: Dataset, endpoint: Endpoint, mcpUrl: string) {
  const name = toolName(dataset, endpoint);
  const key = `${configKey(config)}|${mcpUrl}|${name}`;
  let wrapper = wrappers.get(key);
  if (!wrapper) {
    wrapper = (async () => {
      const server = await initializedResourceServer(config);
      const accepts = await server.buildPaymentRequirements({
        scheme: "exact",
        network: config.network as `${string}:${string}`,
        payTo: config.payTo,
        price: endpoint.price!,
      });
      const inputs = endpointInputs(endpoint).all;
      return createPaymentWrapper(server, {
        accepts,
        resource: {
          url: mcpUrl,
          description: paymentDescription(dataset, endpoint),
          mimeType: "application/json",
          serviceName: SERVICE_NAME,
          tags: dataset.tags,
        },
        // x402 Bazaar: lets facilitators catalogue the tool for agent discovery
        extensions: paymentExtensions(
          config,
          declareDiscoveryExtension({
            toolName: name,
            description: paymentDescription(dataset, endpoint),
            transport: "streamable-http",
            inputSchema: inputs.schema,
            example: inputs.example,
            output: endpoint.outputExample !== undefined ? { example: endpoint.outputExample } : undefined,
          })
        ),
      });
    })();
    wrapper.catch(() => wrappers.delete(key));
    wrappers.set(key, wrapper);
  }
  return wrapper;
}

function buildServer(datasets: Dataset[], handlers: Hono<AppEnv>, c: Context<AppEnv>): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  for (const dataset of datasets) {
    for (const endpoint of dataset.endpoints) {
      const name = toolName(dataset, endpoint);

      const run = async (args: Record<string, unknown>): Promise<ToolResult> => {
        const res = await handlers.request(toolRequestPath(dataset, endpoint, args), {}, c.env);
        return textResult(await res.json(), res.status >= 400);
      };

      server.registerTool(
        name,
        {
          description: toolDescription(dataset, endpoint),
          title: endpoint.summary,
          inputSchema: inputShape(endpoint),
          outputSchema: OUTPUT_SHAPE,
          annotations: { ...TOOL_ANNOTATIONS, title: endpoint.summary },
        },
        async (args: Record<string, unknown>, extra: unknown) => {
          if (!isPaid(endpoint) || c.get("tier") === "api_key") return run(args);
          // A call carrying a payment is paid as usual; bots get no free calls
          const payment = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.["x402/payment"];
          if (!payment && c.get("callerType") !== "bot") {
            const free = await freeCall(c, name, () => run(args));
            if (free) return free;
          }
          const config = readX402Config(c.env);
          if (!config) {
            return textResult({ error: "payments_not_configured", message: "Paid tools are not enabled yet." }, true);
          }
          const mcpUrl = new URL("/mcp", c.req.url).toString();
          const paid = await paymentWrapper(config, dataset, endpoint, mcpUrl);
          return paid(run)(args, extra);
        }
      );
    }
  }

  server.registerTool(
    DATA_REQUEST_TOOL,
    {
      description: DATA_REQUEST_DESCRIPTION,
      title: DATA_REQUEST_TITLE,
      inputSchema: dataRequestInputShape,
      annotations: DATA_REQUEST_ANNOTATIONS,
    },
    async (args: Record<string, unknown>) => {
      const { status, body } = await recordDataRequest(c, args, "mcp");
      return textResult(body, status >= 400);
    }
  );

  for (const dataset of datasets) {
    for (const prompt of dataset.prompts ?? []) {
      const argsSchema = Object.fromEntries(
        prompt.args.map((a) => [a.name, a.required ? z.string().describe(a.description) : z.string().optional().describe(a.description)])
      );
      server.registerPrompt(
        prompt.name,
        { title: prompt.title, description: prompt.description, argsSchema },
        (args: Record<string, string | undefined>) => ({
          messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt.text(args) } }],
        })
      );
    }
  }

  for (const resource of mcpResources(datasets, new URL(c.req.url).origin)) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: resource.mimeType },
      async (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: resource.mimeType, text: resource.text() }] })
    );
  }
  return server;
}

// "tools/call solana_validators_get_network_summary [paid]" style summary of a JSON-RPC message or batch
// "name/version" from an initialize request's clientInfo (e.g. "claude-code/2.0.1"),
// limited to a safe character set; null when absent.
export function mcpClientName(info: unknown): string | null {
  if (typeof info !== "object" || info === null) return null;
  const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[^\w.@ +-]/g, "").trim().slice(0, 40) : "");
  const name = clean((info as { name?: unknown }).name);
  const version = clean((info as { version?: unknown }).version);
  return name ? (version ? `${name}/${version}` : name) : null;
}

export function describeMcpCall(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  const parts = messages
    .filter((m): m is Record<string, any> => typeof m === "object" && m !== null && typeof m.method === "string")
    .map((m) => {
      if (m.method === "initialize") {
        const client = mcpClientName(m.params?.clientInfo);
        return client ? `initialize ${client}` : m.method;
      }
      if (m.method !== "tools/call") return m.method;
      const paid = m.params?._meta?.["x402/payment"] ? " [paid]" : "";
      return `tools/call ${String(m.params?.name ?? "?")}${paid}`;
    });
  return parts.length ? parts.join(", ").slice(0, 200) : undefined;
}

// The transport rejects POSTs (406) unless Accept lists both application/json
// and text/event-stream. Some clients omit it; responses are always JSON here
// (enableJsonResponse), so fill it in rather than turn them away. The body is
// already parsed and passed separately, so the copy carries no body.
export function withJsonAccept(req: Request): Request {
  const accept = req.headers.get("Accept") ?? "";
  if (accept.includes("application/json") && accept.includes("text/event-stream")) return req;
  const headers = new Headers(req.headers);
  headers.set("Accept", "application/json, text/event-stream");
  return new Request(req.url, { method: req.method, headers });
}

export function mcpRoutes(datasets: Dataset[]): Hono<AppEnv> {
  // Dataset handlers without the HTTP payment middleware; MCP charges per tool call
  const handlers = new Hono<AppEnv>();
  mountDatasets(handlers, datasets);

  const app = new Hono<AppEnv>();
  const handle = async (c: Context<AppEnv>) => {
    const server = buildServer(datasets, handlers, c);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: every request is self-contained
      enableJsonResponse: true,
    });
    await server.connect(transport);

    // Parse the body once so the usage log can record the MCP method and tool
    let parsedBody: unknown;
    if (c.req.method === "POST") {
      try {
        parsedBody = await c.req.json();
      } catch {
        parsedBody = undefined; // the transport reports the parse error
      }
      c.set("logDetail", describeMcpCall(parsedBody));
    }
    if (parsedBody === undefined) return transport.handleRequest(c.req.raw);
    return transport.handleRequest(withJsonAccept(c.req.raw), { parsedBody });
  };
  // A browser opening the endpoint (e.g. a shared link) gets a page on how to
  // connect; MCP clients ask for JSON or an event stream and reach the server.
  app.get("/mcp", async (c, next) => {
    const accept = c.req.header("Accept") ?? "";
    if (accept.includes("text/html") && !accept.includes("text/event-stream")) {
      return c.html(mcpPage(datasets, c), 200, { Vary: "Accept" });
    }
    await next();
  });
  app.all("/mcp", handle);
  // Some clients are configured with the bare origin and POST JSON-RPC to "/".
  // GET / stays the human landing page.
  app.post("/", handle);
  return app;
}
