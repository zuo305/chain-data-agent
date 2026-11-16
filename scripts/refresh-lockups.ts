// Collects every pending SOL stake lockup from mainnet-beta and pushes the
// list to the Worker (POST /internal/ingest/solana-unlocks), authenticated
// with the GitHub Actions OIDC token. Run hourly by
// .github/workflows/refresh-lockups.yml; mainnet-beta refuses
// getProgramAccounts from Cloudflare, so the Worker cannot do it itself.
//
// Usage:
//   npm run refresh-lockups -- --dry-run   # collect and print, push nothing
//   (in GitHub Actions)                    # collect and push
import { BASE_URL } from "../src/service";
import { PUBLIC_RPC_URL } from "../src/datasets/solana-validators/rpc";
import { collectLockups } from "../src/datasets/solana-unlocks/lockups";

const dryRun = process.argv.includes("--dry-run");
const rpcUrl = process.env.SOLANA_RPC_URL || PUBLIC_RPC_URL;
const USER_AGENT = "chain-data-agent-ingest/0.1 (+https://github.com/zuo305/chain-data-agent)";

async function collectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await collectLockups(rpcUrl, Math.floor(Date.now() / 1000));
    } catch (err) {
      if (attempt >= 4) throw err;
      console.warn(`Attempt ${attempt} failed: ${err instanceof Error ? err.message : err}; retrying`);
      await new Promise((r) => setTimeout(r, attempt * 15_000));
    }
  }
}

async function oidcToken(): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("No GitHub OIDC token (run in GitHub Actions with id-token: write)");
  const res = await fetch(`${url}&audience=${encodeURIComponent(BASE_URL)}`, {
    headers: { Authorization: `bearer ${bearer}` },
  });
  if (!res.ok) throw new Error(`OIDC token request: HTTP ${res.status}`);
  return ((await res.json()) as { value: string }).value;
}

const started = Date.now();
const lockups = await collectWithRetry();
const sol = lockups.reduce((a, l) => a + l[1], 0) / 1e9;
console.log(`${lockups.length} pending lockups, ${Math.round(sol).toLocaleString("en")} SOL (${Date.now() - started} ms)`);
if (lockups.length === 0) throw new Error("No lockups found; refusing to push an empty snapshot");

if (dryRun) {
  console.log("Dry run: nothing pushed");
} else {
  const res = await fetch(`${BASE_URL}/internal/ingest/solana-unlocks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await oidcToken()}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ refreshedAt: Date.now(), lockups }),
  });
  const text = await res.text();
  console.log(`Push: HTTP ${res.status} ${text.slice(0, 200)}`);
  if (!res.ok) process.exit(1);
}
