import { Hono } from "hono";
import type { AppEnv, Bindings } from "./types";
import { appendLogDetail, errorDetail, telemetry } from "./platform/telemetry";
import { resolveAccess } from "./platform/access";
import { discoveryRoutes } from "./platform/discovery";
import { mountDatasets, syncDatasets } from "./platform/dataset";
import { x402Payments } from "./platform/x402";
import { mcpRoutes } from "./platform/mcp";
import { admin } from "./platform/admin";
import { wellKnownRoutes } from "./platform/wellknown";
import { datasets } from "./datasets/registry";
import { pruneFreeCalls } from "./platform/freecalls";
import { dataRequestRoutes } from "./platform/requests";
import { CRONS } from "./service";

export const app = new Hono<AppEnv>();

// Order matters: classify caller, resolve tier, then enforce x402 payment
app.use("*", telemetry);
app.use("*", resolveAccess);
app.use("*", x402Payments(datasets));

app.get("/health", (c) => c.json({ ok: true }));

app.route("/", discoveryRoutes(datasets));
app.route("/", mcpRoutes(datasets));
app.route("/", admin);
app.route("/", wellKnownRoutes(datasets));
app.route("/", dataRequestRoutes);
mountDatasets(app, datasets);

app.notFound((c) => c.json({ error: "not_found", message: "See /v1/datasets for available endpoints." }, 404));
app.onError((err, c) => {
  console.error("Unhandled error", err);
  c.set("logDetail", appendLogDetail(c.get("logDetail"), `[error] ${errorDetail(err)}`));
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  // Cron trigger (see wrangler.toml): keeps every dataset in sync
  async scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(syncDatasets(datasets, env, controller.cron));
    // Free call counters only need pruning once a day (the 03:00 UTC run of the 10-minute cron)
    const at = new Date(controller.scheduledTime);
    if (controller.cron === CRONS.tenMinutes && at.getUTCHours() === 3 && at.getUTCMinutes() < 10) {
      ctx.waitUntil(pruneFreeCalls(env.DB).catch((err) => console.error("Pruning free MCP calls failed", err)));
    }
  },
} satisfies ExportedHandler<Bindings>;
