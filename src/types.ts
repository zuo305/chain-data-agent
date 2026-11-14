export type Bindings = {
  // Platform tables (usage log, API keys, free calls, data requests)
  DB: D1Database;
  // Solana JSON-RPC endpoint; unset = the public mainnet-beta endpoint
  SOLANA_RPC_URL?: string;
  // x402 configuration (see wrangler.toml [vars]). Paid endpoints return 503
  // until X402_PAY_TO is set, so nothing paid is ever served for free.
  X402_PAY_TO?: string;
  X402_NETWORK?: string;
  // Base Builder Code (ERC-8021) declared on paid routes and tools so the
  // facilitator attributes settlements to this service onchain. Unset = none.
  BASE_BUILDER_CODE?: string;
  X402_FACILITATOR_URL?: string;
  // Secrets (Cloudflare dashboard, never in the repo). When both are set and
  // X402_FACILITATOR_URL is empty, payments go through the CDP facilitator,
  // which also lists paid resources in the x402 Bazaar.
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  // JSON issued by Glama to claim our connector listing, served verbatim at
  // /.well-known/glama.json. Unset = 404.
  GLAMA_CONNECTOR_JSON?: string;
  // Hash issued by 402index.io to verify the domain, served at
  // /.well-known/402index-verify.txt. Unset = 404.
  INDEX402_VERIFY_HASH?: string;
  // Directory badges shown in the site footer, as JSON [{ "href", "img", "alt" }].
  // Some directories verify ownership by finding their badge link.
  LISTING_BADGES_JSON?: string;
  // Public contact email shown on the site for data requests. Unset = not shown.
  CONTACT_EMAIL?: string;
  // Site verification <meta> tags in every page head, as JSON [{ "name", "content" }]
  SITE_VERIFICATION_META_JSON?: string;
  // Secret bearer token for /admin/* (read-only usage stats). Unset = disabled.
  ADMIN_TOKEN?: string;
  // Secret key for the anonymous client id in usage_log (see clientid.ts).
  // Unset = falls back to ADMIN_TOKEN; neither = no client ids.
  CLIENT_ID_SECRET?: string;
  PUBLIC_BASE_URL?: string;
};

export type AccessTier = "free" | "api_key" | "x402";

export type CallerType = "human" | "agent" | "bot" | "unknown";

export type Variables = {
  tier: AccessTier;
  // Set when the request carries a valid API key
  apiKeyId?: number;
  callerType: CallerType;
  callerName: string | null;
  wantsMarkdown: boolean;
  // Extra context for the usage log, e.g. the MCP method and tool name
  logDetail?: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
