import { SERVICE } from "../service";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { clientId } from "./clientid";

// Data requests: callers say which data they need that the service does not
// provide yet, through the free request_data MCP tool or POST
// /v1/data-requests. Stored in data_request and listed in /admin/usage.

export const DATA_REQUEST_MAX_LENGTH = 500;
export const DATA_REQUESTS_PER_CLIENT_PER_DAY = 5;
// Bounds the rows written per day whatever the number of clients
export const DATA_REQUESTS_PER_DAY = 200;

export const DATA_REQUEST_TOOL = "request_data";

export const DATA_REQUEST_DESCRIPTION =
  `Request data that these tools do not provide yet (${SERVICE.requestExamples}), ` +
  "so the maintainers can consider it for a future release. Free. Describe the data and, optionally, the " +
  "task it is for. Do not include personal information. Requests are stored anonymously and read by the " +
  "maintainers; the result is only a confirmation.";

export const DATA_REQUEST_TITLE = "Request data that is not covered yet";

export const dataRequestInputShape = {
  request: z.string().describe(`The data you need, e.g. ${SERVICE.requestExample}`),
  use_case: z.string().optional().describe("Optional: the task you need it for"),
};

// Writes a row, so unlike the data tools it is not read-only or idempotent
export const DATA_REQUEST_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  title: DATA_REQUEST_TITLE,
} as const;

// Same tool as listed by tools/list, for the static MCP server card
export function dataRequestToolCard() {
  return {
    name: DATA_REQUEST_TOOL,
    description: DATA_REQUEST_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: dataRequestInputShape.request.description },
        use_case: { type: "string", description: dataRequestInputShape.use_case.description },
      },
      required: ["request"],
    },
    annotations: DATA_REQUEST_ANNOTATIONS,
  };
}

export type DataRequestInput = { request?: unknown; use_case?: unknown };
type Channel = "mcp" | "http";

const clean = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, DATA_REQUEST_MAX_LENGTH) : "";

export async function recordDataRequest(
  c: Context<AppEnv>,
  input: DataRequestInput,
  channel: Channel
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = clean(input.request);
  const useCase = clean(input.use_case) || null;
  if (request.length < 3) {
    return { status: 400, body: { error: "bad_request", message: "Describe the data you need in the request field." } };
  }
  const db = c.env.DB;
  const client = await clientId(c.req.header("CF-Connecting-IP"), c.env.CLIENT_ID_SECRET ?? c.env.ADMIN_TOKEN);
  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(client_id IS ? ) AS mine FROM data_request
       WHERE created_at >= datetime('now', 'start of day')`
    )
    .bind(client)
    .first<{ total: number; mine: number | null }>();
  if ((counts?.mine ?? 0) >= DATA_REQUESTS_PER_CLIENT_PER_DAY || (counts?.total ?? 0) >= DATA_REQUESTS_PER_DAY) {
    return { status: 429, body: { error: "rate_limited", message: "Daily limit for data requests reached; try again tomorrow." } };
  }
  await db
    .prepare("INSERT INTO data_request (request, use_case, channel, caller_name, client_id) VALUES (?, ?, ?, ?, ?)")
    .bind(request, useCase, channel, c.get("callerName") ?? null, client)
    .run();
  c.set("logDetail", channel === "mcp" ? `tools/call ${DATA_REQUEST_TOOL}` : "data request");
  return { status: 200, body: { data: { received: true }, meta: { note: "Thanks. The maintainers read every request." } } };
}

export const dataRequestRoutes = new Hono<AppEnv>();

dataRequestRoutes.post("/v1/data-requests", async (c) => {
  let input: DataRequestInput = {};
  try {
    input = (await c.req.json()) as DataRequestInput;
  } catch {
    // validated below
  }
  const { status, body } = await recordDataRequest(c, input, "http");
  return c.json(body, status as 200);
});
