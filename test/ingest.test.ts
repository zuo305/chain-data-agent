import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { GITHUB_OIDC_ISSUER, verifyGithubOidc } from "../src/platform/oidc";
import { BASE_URL, INGEST } from "../src/service";
import { readFileSync } from "node:fs";
import { createTestD1 } from "./helpers/d1";

// GitHub OIDC tokens signed with a locally generated key that the stubbed
// JWKS endpoint publishes
let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };
const b64url = (data: Uint8Array | string) =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...data)).split("+").join("-").split("/").join("_").replace(/=+$/, "");

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "test-key" };
});

async function token(overrides: Record<string, unknown> = {}, kid = "test-key") {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: GITHUB_OIDC_ISSUER,
    aud: INGEST.audience,
    exp: now + 300,
    nbf: now - 10,
    repository: INGEST.githubRepository,
    ref: INGEST.ref,
    ...overrides,
  };
  const head = b64url(JSON.stringify({ alg: "RS256", kid }));
  const body = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`))
  );
  return `${head}.${body}.${b64url(sig)}`;
}

const jwks = async () => [jwk];
const EXPECT = { repository: INGEST.githubRepository, ref: INGEST.ref, audience: INGEST.audience };

describe("GitHub OIDC verification", () => {
  it("accepts a token from our repository on main", async () => {
    const claims = await verifyGithubOidc(await token(), EXPECT, jwks);
    expect(typeof claims).toBe("object");
  });

  it("rejects other repositories, refs, audiences, expired and tampered tokens", async () => {
    expect(await verifyGithubOidc(await token({ repository: "someone/else" }), EXPECT, jwks)).toBe("wrong repository");
    expect(await verifyGithubOidc(await token({ ref: "refs/heads/dev" }), EXPECT, jwks)).toBe("wrong ref");
    expect(await verifyGithubOidc(await token({ aud: "https://other.example" }), EXPECT, jwks)).toBe("wrong audience");
    expect(await verifyGithubOidc(await token({ exp: 1 }), EXPECT, jwks)).toBe("expired");
    expect(await verifyGithubOidc(await token({ iss: "https://evil.example" }), EXPECT, jwks)).toBe("wrong issuer");
    const good = await token();
    const [h, , s] = good.split(".");
    const forged = `${h}.${b64url(JSON.stringify({ iss: GITHUB_OIDC_ISSUER, repository: INGEST.githubRepository }))}.${s}`;
    expect(await verifyGithubOidc(forged, EXPECT, jwks)).toBe("bad signature");
    expect(await verifyGithubOidc(await token({}, "other-key"), EXPECT, jwks)).toBe("unknown signing key");
    expect(await verifyGithubOidc("not-a-jwt", EXPECT, jwks)).toBe("malformed token");
  });
});

describe("POST /internal/ingest/:dataset", () => {
  afterEach(() => vi.unstubAllGlobals());

  const fixture = JSON.parse(readFileSync("fixtures/solana/lockups.json", "utf8"));
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

  async function post(path: string, body: unknown, auth?: string) {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(GITHUB_OIDC_ISSUER) ? Response.json({ keys: [jwk] }) : realFetch(input, init)
    );
    const db = createTestD1();
    const res = await app.request(
      `${BASE_URL}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify(body),
      },
      { DB: db },
      ctx
    );
    return { res, db };
  }

  it("stores a valid snapshot pushed by our workflow", async () => {
    const { res, db } = await post(
      "/internal/ingest/solana-unlocks",
      { refreshedAt: Date.now(), lockups: fixture.lockups },
      `Bearer ${await token()}`
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).stored).toBe(fixture.lockups.length);
    expect((db.sqlite.prepare("SELECT count(*) n FROM rpc_snapshot").get() as { n: number }).n).toBe(1);
  });

  it("rejects missing or foreign tokens, bad bodies and unknown datasets", async () => {
    const body = { refreshedAt: Date.now(), lockups: fixture.lockups };
    expect((await post("/internal/ingest/solana-unlocks", body)).res.status).toBe(401);
    expect((await post("/internal/ingest/solana-unlocks", body, `Bearer ${await token({ repository: "x/y" })}`)).res.status).toBe(401);
    expect((await post("/internal/ingest/solana-unlocks", { lockups: [] }, `Bearer ${await token()}`)).res.status).toBe(400);
    expect((await post("/internal/ingest/solana-validators", body, `Bearer ${await token()}`)).res.status).toBe(404);
  });
});
