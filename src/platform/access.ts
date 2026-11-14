import type { MiddlewareHandler } from "hono";
import type { AppEnv, AccessTier } from "../types";
import { apiKeyFromHeaders, findApiKey } from "./apikeys";

// Resolves the baseline access tier for the current request. A valid API key
// gives the "api_key" tier, which skips x402 on paid endpoints and tools; the
// x402 middleware upgrades the tier to "x402" once a payment has been verified.
export const resolveAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  let tier: AccessTier = "free";

  const key = apiKeyFromHeaders(c.req.header("Authorization"), c.req.header("X-API-Key"));
  if (key) {
    const record = await findApiKey(c.env.DB, key);
    if (!record) {
      return c.json(
        { error: "invalid_api_key", message: "The API key is unknown or revoked. Remove it to pay per call via x402." },
        401
      );
    }
    tier = "api_key";
    c.set("apiKeyId", record.id);
  }

  c.set("tier", tier);
  await next();
};
