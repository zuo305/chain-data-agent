import type { Context, MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient, type FacilitatorConfig } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { RouteConfig, RoutesConfig } from "@x402/core/server";
import type { AppEnv, Bindings } from "../types";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import {
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  builderCodeResourceServerExtension,
  declareBuilderCodeExtension,
} from "@x402/extensions/builder-code";
import { appendLogDetail, errorDetail } from "./telemetry";
import { paymentRequiredPage, paymentRequirement } from "./site";
import { type Dataset, type Endpoint, SERVICE_NAME, endpointFullPath, endpointInputs, isPaid } from "./dataset";

// Base Sepolia testnet by default; Base mainnet is "eip155:8453".
// Facilitator: CDP when its API key secrets are set (needed for x402 Bazaar
// listing), otherwise the public x402.org facilitator (testnet only).
const DEFAULT_NETWORK = "eip155:84532";
const PUBLIC_FACILITATOR_URL = "https://x402.org/facilitator";
// Fail fast instead of holding the request open if the facilitator stalls.
const FACILITATOR_TIMEOUT_MS = 10_000;

export type X402Config = {
  payTo: string;
  network: string;
  // "cdp" or a facilitator URL
  facilitator: string;
  cdpKey?: { id: string; secret: string };
  // Base Builder Code (ERC-8021) the facilitator appends to settlements
  builderCode?: string;
};

export function readX402Config(env: Bindings): X402Config | null {
  const payTo = env.X402_PAY_TO?.trim();
  if (!payTo) return null;
  const network = env.X402_NETWORK?.trim() || DEFAULT_NETWORK;
  const url = env.X402_FACILITATOR_URL?.trim();
  const id = env.CDP_API_KEY_ID?.trim();
  const secret = env.CDP_API_KEY_SECRET?.trim();
  const builderCode = readBuilderCode(env.BASE_BUILDER_CODE);
  const extra = builderCode ? { builderCode } : {};
  if (!url && id && secret) return { payTo, network, facilitator: "cdp", cdpKey: { id, secret }, ...extra };
  return { payTo, network, facilitator: url || PUBLIC_FACILITATOR_URL, ...extra };
}

function readBuilderCode(value: string | undefined): string | undefined {
  const code = value?.trim();
  if (!code) return undefined;
  if (!BUILDER_CODE_PATTERN.test(code)) {
    console.warn(`Ignoring invalid BASE_BUILDER_CODE "${code}"`);
    return undefined;
  }
  return code;
}

// Extensions declared on every paid route and MCP tool: the given discovery
// extension plus, when configured, the Base Builder Code that attributes
// settlements to this service onchain.
export function paymentExtensions(config: X402Config, discovery: Record<string, unknown>): Record<string, unknown> {
  return config.builderCode
    ? { ...discovery, [BUILDER_CODE]: declareBuilderCodeExtension(config.builderCode) }
    : discovery;
}

function facilitatorConfig(config: X402Config): FacilitatorConfig {
  if (config.cdpKey) {
    return { ...createFacilitatorConfig(config.cdpKey.id, config.cdpKey.secret), timeoutMs: FACILITATOR_TIMEOUT_MS };
  }
  return { url: config.facilitator, timeoutMs: FACILITATOR_TIMEOUT_MS };
}

// Builds the x402 route table ("GET /v1/solana-validators/validator" -> price) from
// dataset definitions. Exported for tests.
export function buildPaidRoutes(datasets: Dataset[], config: X402Config): RoutesConfig {
  const routes: Record<string, RouteConfig> = {};
  for (const dataset of datasets) {
    for (const endpoint of dataset.endpoints) {
      if (!isPaid(endpoint)) continue;
      const inputs = endpointInputs(endpoint);
      const hasPathParams = Object.keys(inputs.path.schema.properties).length > 0;
      routes[`${endpoint.method} ${endpointFullPath(dataset, endpoint)}`] = {
        accepts: {
          scheme: "exact",
          price: endpoint.price!,
          network: config.network as `${string}:${string}`,
          payTo: config.payTo,
        },
        description: `${dataset.title}: ${endpoint.summary}`,
        mimeType: "application/json",
        serviceName: SERVICE_NAME,
        tags: dataset.tags,
        // Body for unpaid API requests; payment details are in the PAYMENT-REQUIRED header
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            error: "payment_required",
            message:
              `This endpoint costs ${endpoint.price} per call via x402. Retry with a PAYMENT-SIGNATURE header.` +
              (endpoint.preview ? " The preview field, when present, shows what this call would return." : ""),
            docs: `/docs/${dataset.id}.md`,
            free_endpoints: dataset.endpoints.filter((e) => !isPaid(e)).map((e) => endpointFullPath(dataset, e)),
          },
        }),
        // x402 Bazaar: lets facilitators catalogue the route for agent discovery
        extensions: paymentExtensions(
          config,
          declareDiscoveryExtension({
            input: inputs.query.example,
            inputSchema: inputs.query.schema,
            ...(hasPathParams ? { pathParams: inputs.path.example, pathParamsSchema: inputs.path.schema } : {}),
            output: endpoint.outputExample !== undefined ? { example: endpoint.outputExample } : undefined,
          })
        ),
      };
    }
  }
  return routes;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// The paid endpoint a request targets (Hono-style :params), with its path params.
export function findPaidEndpoint(
  datasets: Dataset[],
  method: string,
  path: string
): { endpoint: Endpoint; params: Record<string, string> } | null {
  for (const dataset of datasets) {
    for (const endpoint of dataset.endpoints) {
      if (!isPaid(endpoint) || endpoint.method !== method) continue;
      const names: string[] = [];
      const pattern = endpointFullPath(dataset, endpoint)
        .split("/")
        .map((segment) => {
          if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          names.push(segment.slice(1));
          return "([^/]+)";
        })
        .join("/");
      const match = new RegExp(`^${pattern}/?$`).exec(path);
      if (!match) continue;
      const params = Object.fromEntries(names.map((name, i) => [name, safeDecode(match[i + 1])]));
      return { endpoint, params };
    }
  }
  return null;
}

// Adds the endpoint's free preview to an unpaid 402. Agents get it in the
// JSON body; a browser gets a readable page with the price, network and
// preview in place of the x402 library's bare paywall. A failing preview never
// blocks the 402 itself.
export async function withPreview(
  c: Context<AppEnv>,
  res: Response,
  target: { endpoint: Endpoint; params: Record<string, string> } | null
): Promise<Response> {
  if (!target) return res;
  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const isHtml = contentType.includes("text/html");
  if (!isJson && !isHtml) return res;
  let preview: Record<string, unknown> | null = null;
  if (target.endpoint.preview) {
    try {
      preview = await target.endpoint.preview(c, target.params);
    } catch (err) {
      console.error("x402 preview failed", err);
    }
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  if (isHtml) {
    const requirement = paymentRequirement(res.headers.get("payment-required"));
    headers.set("content-type", "text/html; charset=UTF-8");
    return new Response(paymentRequiredPage(c, target.endpoint, requirement, preview), { status: res.status, headers });
  }
  if (!preview) return res;
  const body = (await res.clone().json()) as Record<string, unknown>;
  return new Response(JSON.stringify({ ...body, preview }), { status: res.status, headers });
}

export const configKey = (config: X402Config) =>
  `${config.payTo}|${config.network}|${config.facilitator}|${config.cdpKey?.id ?? ""}|${config.builderCode ?? ""}`;

// One resource server per isolate and configuration, shared by the HTTP
// middleware and the MCP server.
let serverCache: { key: string; server: x402ResourceServer; ready: Promise<void> | null } | null = null;

export function resourceServer(config: X402Config): x402ResourceServer {
  const key = configKey(config);
  if (!serverCache || serverCache.key !== key) {
    const facilitator = new HTTPFacilitatorClient(facilitatorConfig(config));
    const server = new x402ResourceServer(facilitator).register(
      config.network as `${string}:${string}`,
      new ExactEvmScheme()
    );
    server.registerExtension(bazaarResourceServerExtension);
    server.registerExtension(builderCodeResourceServerExtension);
    serverCache = { key, server, ready: null };
  }
  return serverCache.server;
}

// Resource server with the facilitator's supported kinds loaded; retried on
// the next call if the facilitator was unreachable.
export async function initializedResourceServer(config: X402Config): Promise<x402ResourceServer> {
  const server = resourceServer(config);
  const entry = serverCache!;
  entry.ready ??= server.initialize().catch((err) => {
    entry.ready = null;
    throw err;
  });
  await entry.ready;
  return server;
}

// The x402 middleware is built lazily on the first request, because Worker
// env bindings are only available per request. It is cached per isolate and
// rebuilt only if the configuration changes.
let cached: { key: string; middleware: MiddlewareHandler } | null = null;

// Wait before retrying a request that failed in the x402 middleware before
// reaching the handler (see x402Payments)
export const FACILITATOR_RETRY_DELAY_MS = 500;

export function x402Payments(datasets: Dataset[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // API key holders are billed by the partner that issued their access
    if (c.get("tier") === "api_key") return next();
    const config = readX402Config(c.env);
    if (!config) {
      if (findPaidEndpoint(datasets, c.req.method, c.req.path)) {
        return c.json(
          { error: "payments_not_configured", message: "Paid endpoints are not enabled on this deployment yet." },
          503
        );
      }
      return next();
    }

    const key = configKey(config);
    if (!cached || cached.key !== key) {
      cached = { key, middleware: paymentMiddleware(buildPaidRoutes(datasets, config), resourceServer(config)) };
    }

    // The middleware only calls through to the handler once a payment has
    // been verified (or the route is free), so the tier is set accurately.
    const paid = Boolean(c.req.header("payment-signature") || c.req.header("x-payment"));
    let reachedHandler = false;
    const run = () =>
      cached!.middleware(c, async () => {
        reachedHandler = true;
        if (paid) c.set("tier", "x402");
        await next();
      });
    let res = await run();
    // A new isolate loads the facilitator's supported payment kinds first, and
    // the facilitator's edge occasionally answers with a short-lived 403
    // challenge. Nothing was verified or settled yet, so try once more.
    if (res instanceof Response && res.status >= 500 && !reachedHandler) {
      await new Promise((resolve) => setTimeout(resolve, FACILITATOR_RETRY_DELAY_MS));
      res = await run();
    }
    // Payment verification or settlement failed inside the x402 middleware,
    // which answers 5xx itself without throwing: log what it reported
    if (res instanceof Response && res.status >= 500 && !reachedHandler) {
      const reported = await res
        .clone()
        .json<{ error?: unknown }>()
        .then((body) => body?.error)
        .catch(() => undefined);
      const tag = `[x402 error] ${paid ? "with payment" : "no payment"}: ${errorDetail(reported ?? "unknown")}`;
      c.set("logDetail", appendLogDetail(c.get("logDetail"), tag));
      // The facilitator is still unreachable after the retry; the next request
      // tries again. A 503 tells agents to retry rather than that the API is
      // broken.
      return c.json(
        {
          error: "payment_facilitator_unavailable",
          message: "The x402 payment facilitator could not be reached. No payment was taken; retry in a few seconds.",
        },
        503,
        { "Retry-After": "5" }
      );
    }
    // Unpaid request: show what the call would return before the agent pays
    if (res instanceof Response && res.status === 402 && !paid && c.req.method === "GET") {
      return withPreview(c, res, findPaidEndpoint(datasets, c.req.method, c.req.path));
    }
    return res;
  };
}
