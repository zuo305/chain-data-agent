// Lists every paid HTTP route and MCP tool in the CDP x402 Bazaar. The Bazaar
// catalogues a resource only after a payment for it settles through the CDP
// facilitator, so this pays for each one once, with its documented example
// input. Without --pay it only checks, via the free 402 preview, that each
// example would succeed (failed calls are not charged and not listed).
//
// Usage:
//   npm run bazaar:list                                   # check only, pays nothing
//   PAYER_PRIVATE_KEY=0x... npm run bazaar:list -- --pay  # pay once per resource
//   options: --http or --mcp to limit the kind, --only <tool or path substring>,
//            --base <origin> (default: production)
//
// The wallet needs USDC on the network the server charges on (Base mainnet in
// production). Use a dedicated wallet with a few dollars; never commit its key.
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { createx402MCPClient } from "@x402/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount } from "viem/accounts";
import { datasets } from "../src/datasets/registry";
import { BASE_URL } from "../src/service";
import { endpointFullPath, endpointInputs, isPaid, toolName } from "../src/platform/dataset";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = option("--base") ?? BASE_URL;
const only = option("--only");
const pay = flag("--pay");
const kinds = flag("--http") || flag("--mcp") ? { http: flag("--http"), mcp: flag("--mcp") } : { http: true, mcp: true };

// Identifies as an automated client, so the server's free MCP calls do not
// apply and every call goes through x402
const USER_AGENT = "chain-data-agent-bazaar-list/0.1 (+https://github.com/zuo305/chain-data-agent)";

type Target = { kind: "http" | "mcp"; name: string; price: string; url: string; tool: string; toolArgs: Record<string, unknown> };

const targets: Target[] = [];
for (const dataset of datasets) {
  for (const endpoint of dataset.endpoints) {
    if (!isPaid(endpoint)) continue;
    const inputs = endpointInputs(endpoint);
    let path = endpointFullPath(dataset, endpoint);
    for (const [name, value] of Object.entries(inputs.path.example)) path = path.replace(`:${name}`, encodeURIComponent(String(value)));
    const qs = new URLSearchParams(Object.entries(inputs.query.example).map(([k, v]) => [k, String(v)])).toString();
    const url = `${base}${path}${qs ? `?${qs}` : ""}`;
    const tool = toolName(dataset, endpoint);
    for (const kind of ["http", "mcp"] as const) {
      if (!kinds[kind]) continue;
      const name = kind === "http" ? `GET ${endpointFullPath(dataset, endpoint)}` : `tool ${tool}`;
      if (only && !name.includes(only)) continue;
      targets.push({ kind, name, price: endpoint.price!, url, tool, toolArgs: inputs.all.example });
    }
  }
}

const total = targets.reduce((sum, t) => sum + Number(t.price.replace("$", "")), 0);
console.log(`${targets.length} resources, $${total.toFixed(3)} in total${pay ? "" : " (check only, nothing is paid)"}\n`);

// The free preview in the unpaid 402 says whether the example input is valid
async function check(target: Target): Promise<boolean> {
  const res = await fetch(target.url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  const body = (await res.json().catch(() => ({}))) as { preview?: Record<string, unknown> };
  const preview = body.preview;
  const ok = res.status === 402 && preview?.valid !== false && preview?.exists !== false && preview?.matches !== 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${target.name} (${target.price}) ${res.status} ${JSON.stringify(preview ?? {})}`);
  return ok;
}

async function payHttp(target: Target, key: `0x${string}`) {
  const account = privateKeyToAccount(key);
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
  });
  const res = await fetchWithPayment(target.url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  const settlement = res.headers.get("payment-response");
  const tx = settlement ? (decodePaymentResponseHeader(settlement) as { transaction?: string }).transaction : undefined;
  console.log(`${res.ok ? "paid" : "FAIL"} ${target.name} ${res.status}${tx ? ` tx ${tx}` : ""}`);
}

async function payMcp(target: Target, key: `0x${string}`) {
  const account = privateKeyToAccount(key);
  const client = createx402MCPClient({
    name: "bazaar-list",
    version: "0.1.0",
    schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
    autoPayment: true,
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { "User-Agent": USER_AGENT } } })
  );
  try {
    const result = await client.callTool(target.tool, target.toolArgs);
    const tx = (result.paymentResponse as { transaction?: string } | undefined)?.transaction;
    console.log(`${result.paymentMade && !result.isError ? "paid" : "FAIL"} ${target.name}${tx ? ` tx ${tx}` : ""}`);
  } finally {
    await client.close();
  }
}

const valid: Target[] = [];
for (const target of targets) if (await check(target)) valid.push(target);

if (pay) {
  const key = process.env.PAYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) {
    console.error("\nSet PAYER_PRIVATE_KEY to pay.");
    process.exit(1);
  }
  console.log(`\nPaying from ${privateKeyToAccount(key).address}`);
  for (const target of valid) {
    try {
      await (target.kind === "http" ? payHttp(target, key) : payMcp(target, key));
    } catch (err) {
      console.log(`FAIL ${target.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("\nListings appear in the Bazaar shortly after settlement:");
  console.log(`  curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=<payee>&limit=50"`);
}
