// Calls a paid endpoint and pays with x402, for end-to-end checks.
//
// Usage:
//   PAYER_PRIVATE_KEY=0x... npm run x402:pay -- <url>
//
// Use a dedicated testnet wallet; never commit its key.
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const url = process.argv[2];
const key = process.env.PAYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!url || !key) {
  console.error("Usage: PAYER_PRIVATE_KEY=0x... npm run x402:pay -- <url>");
  process.exit(1);
}

const account = privateKeyToAccount(key);
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
});

console.error(`Payer: ${account.address}`);
const response = await fetchWithPayment(url, { headers: { Accept: "application/json" } });
console.error(`Status: ${response.status}`);

const settlement = response.headers.get("payment-response");
if (settlement) console.error("Settlement:", JSON.stringify(decodePaymentResponseHeader(settlement), null, 2));

console.log(JSON.stringify(await response.json(), null, 2));
