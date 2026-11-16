import { Hono } from "hono";
import type { AppEnv } from "../types";
import type { Dataset } from "./dataset";
import { verifyGithubOidc } from "./oidc";
import { INGEST } from "../service";
import { appendLogDetail } from "./telemetry";

// POST /internal/ingest/<dataset id>: data pushed by a GitHub Actions
// workflow of our own repository (for sources that refuse Cloudflare's
// addresses), authenticated with the workflow's OIDC token. Not part of the
// public API, docs or MCP tools.

export const INGEST_MAX_BYTES = 2_000_000;

export function ingestRoutes(datasets: Dataset[]) {
  const app = new Hono<AppEnv>();
  app.post("/internal/ingest/:id", async (c) => {
    const dataset = datasets.find((d) => d.id === c.req.param("id") && d.ingest);
    if (!dataset?.ingest) return c.json({ error: "not_found" }, 404);
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const claims = await verifyGithubOidc(token, {
      repository: INGEST.githubRepository,
      ref: INGEST.ref,
      audience: INGEST.audience,
    });
    if (typeof claims === "string") {
      c.set("logDetail", appendLogDetail(c.get("logDetail"), `[ingest] rejected: ${claims}`));
      return c.json({ error: "unauthorized", message: claims }, 401);
    }
    const text = await c.req.text();
    if (text.length > INGEST_MAX_BYTES) return c.json({ error: "too_large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "bad_request", message: "Body must be JSON." }, 400);
    }
    return dataset.ingest(c, body);
  });
  return app;
}
