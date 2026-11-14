// Calls an MCP tool and pays with x402, for end-to-end checks.
//
// Usage:
//   PAYER_PRIVATE_KEY=0x... npm run x402:mcp-pay -- <mcp-url> <tool> '<json args>'
//
// Use a dedicated testnet wallet; never commit its key.
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount } from "viem/accounts";

const [url, tool, rawArgs = "{}"] = process.argv.slice(2);
const key = process.env.PAYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!url || !tool || !key) {
  console.error("Usage: PAYER_PRIVATE_KEY=0x... npm run x402:mcp-pay -- <mcp-url> <tool> '<json args>'");
  process.exit(1);
}

const account = privateKeyToAccount(key);
const client = createx402MCPClient({
  name: "x402-mcp-pay",
  version: "0.1.0",
  schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
  autoPayment: true,
});
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

console.error(`Payer: ${account.address}`);
const result = await client.callTool(tool, JSON.parse(rawArgs));
console.error(`Payment made: ${result.paymentMade}`);
if (result.paymentResponse) console.error("Settlement:", JSON.stringify(result.paymentResponse, null, 2));
console.log(result.content.map((c) => ("text" in c ? c.text : JSON.stringify(c))).join("\n"));
await client.close();
