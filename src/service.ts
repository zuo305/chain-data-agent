// Identity of this service, used by the platform for the site, MCP server
// info, discovery files and x402 metadata. Datasets stay in src/datasets/.

// Public origin of the deployed Worker.
// TODO: set to the real workers.dev URL once the Cloudflare account exists.
export const BASE_URL = "https://chain-data-agent.workers.dev";

export const SERVICE = {
  // Shown for paid resources in the x402 Bazaar (max 32 printable ASCII chars)
  name: "Chain Data Agent",
  // MCP server name and title
  mcpName: "chain-data-agent",
  mcpTitle: "Chain Data for Agents (x402)",
  version: "0.1.0",
  // One line, used as the site tagline and in catalog descriptions
  tagline: "On-chain data for AI agents, computed live from public chain state",
  description:
    "Blockchain data for AI agents, computed live from public chain state: Solana network health " +
    "(epoch progress, validator count, stake concentration, skip rate) and per-validator stats " +
    "(stake, commission, vote credits, block production, delinquency). Free summary tools; paid " +
    "tools charge per call via x402 (USDC on Base).",
  // Free tool an agent should call first
  firstTool: "solana_validators_get_network_summary",
  // Examples of data a caller might request that is not covered yet
  requestExamples: "another chain, a dataset, a field or a filter",
  requestExample: "'token unlock schedules' or 'Ethereum validator stats'",
} as const;
