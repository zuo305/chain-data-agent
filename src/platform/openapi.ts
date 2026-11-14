import { SERVICE } from "../service";
import type { Bindings } from "../types";
import { type Dataset, SERVICE_NAME, endpointFullPath, isPaid, toolName } from "./dataset";
import { readX402Config } from "./x402";

// OpenAPI 3.1 description generated from dataset definitions. Paid
// operations carry "x-payment-info" (the structured shape x402 crawlers such
// as x402scan read) and an "x-x402" extension with price and network; the
// live 402 response remains authoritative.

const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z_]\w*)/g, "{$1}");

export function openApiDocument(datasets: Dataset[], env: Bindings, origin: string) {
  const x402 = readX402Config(env);
  const paths: Record<string, Record<string, unknown>> = {};

  for (const dataset of datasets) {
    for (const endpoint of dataset.endpoints) {
      const path = toOpenApiPath(endpointFullPath(dataset, endpoint));
      const responses: Record<string, unknown> = {
        "200": {
          description: "Data with attribution: { data, meta, attribution }",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DataEnvelope" },
              ...(endpoint.outputExample !== undefined ? { example: endpoint.outputExample } : {}),
            },
          },
        },
        "400": { description: "Invalid parameters", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      };
      if (isPaid(endpoint)) {
        responses["402"] = {
          description:
            "Payment required (x402). Payment requirements are in the PAYMENT-REQUIRED header; " +
            "retry with a PAYMENT-SIGNATURE header.",
        };
        responses["503"] = { description: "Payments not configured on this deployment" };
      }

      paths[path] ??= {};
      paths[path][endpoint.method.toLowerCase()] = {
        operationId: toolName(dataset, endpoint),
        summary: endpoint.summary,
        ...(endpoint.details ? { description: endpoint.details } : {}),
        tags: [dataset.id],
        parameters: (endpoint.params ?? []).map((p) => ({
          name: p.name,
          in: p.in === "path" ? "path" : "query",
          required: p.in === "path" ? true : Boolean(p.required),
          description: p.description,
          schema: { type: "string" },
          ...(p.example !== undefined ? { example: p.example } : {}),
        })),
        // No API authentication; payment is declared separately
        security: [],
        responses,
        ...(isPaid(endpoint)
          ? {
              "x-payment-info": {
                price: { mode: "fixed", currency: "USD", amount: endpoint.price!.replace(/^\$/, "") },
                protocols: [{ x402: {} }],
              },
              "x-x402": {
                price: endpoint.price,
                scheme: "exact",
                ...(x402 ? { network: x402.network, payTo: x402.payTo } : {}),
              },
            }
          : {}),
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE_NAME,
      version: "0.1.0",
      description:
        `${SERVICE.tagline}. Paid operations use x402 ` +
        "(USDC, no signup). Every response includes an attribution object that must be kept.",
    },
    servers: [{ url: origin }],
    externalDocs: { description: "Agent-oriented docs", url: `${origin}/llms.txt` },
    "x-agentcash-guidance": { llmsTxtUrl: `${origin}/llms.txt` },
    tags: datasets.map((d) => ({ name: d.id, description: `${d.title}. ${d.description}` })),
    paths,
    components: {
      schemas: {
        DataEnvelope: {
          type: "object",
          required: ["data", "meta", "attribution"],
          properties: {
            data: {},
            meta: { type: "object" },
            attribution: {
              type: "object",
              properties: {
                publisher: { type: "string" },
                licence: { type: "string" },
                licenceUrl: { type: "string" },
                text: { type: "string" },
              },
            },
          },
        },
        Error: {
          type: "object",
          properties: { error: { type: "string" }, message: { type: "string" } },
        },
      },
    },
  };
}
