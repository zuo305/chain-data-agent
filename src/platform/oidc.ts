// Verifies GitHub Actions OIDC tokens (RS256 JWTs from
// token.actions.githubusercontent.com), so a workflow in our own repository
// can push data to the Worker without a shared secret.

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 3_600_000;
// Allowed clock difference between GitHub and the Worker
const LEEWAY_SECONDS = 60;

export type GithubClaims = {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  repository: string;
  ref: string;
  event_name?: string;
  workflow_ref?: string;
};

export type OidcExpectations = { repository: string; ref: string; audience: string };

type Jwk = JsonWebKey & { kid: string };
let jwks: { keys: Jwk[]; at: number } | null = null;

async function signingKey(kid: string, fetchJwks: () => Promise<Jwk[]>): Promise<CryptoKey | null> {
  if (!jwks || Date.now() - jwks.at > JWKS_TTL_MS || !jwks.keys.some((k) => k.kid === kid)) {
    jwks = { keys: await fetchJwks(), at: Date.now() };
  }
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

async function defaultFetchJwks(): Promise<Jwk[]> {
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  return ((await res.json()) as { keys: Jwk[] }).keys;
}

const fromBase64Url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) =>
    c.charCodeAt(0)
  );

// The token's claims if it is valid and matches the expectations, else the reason
export async function verifyGithubOidc(
  token: string,
  expect: OidcExpectations,
  fetchJwks: () => Promise<Jwk[]> = defaultFetchJwks
): Promise<GithubClaims | string> {
  const parts = token.split(".");
  if (parts.length !== 3) return "malformed token";
  let header: { alg?: string; kid?: string };
  let claims: GithubClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1])));
  } catch {
    return "malformed token";
  }
  if (header.alg !== "RS256" || !header.kid) return "unsupported token";
  const key = await signingKey(header.kid, fetchJwks);
  if (!key) return "unknown signing key";
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return "bad signature";
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== GITHUB_OIDC_ISSUER) return "wrong issuer";
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expect.audience)) return "wrong audience";
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS < now) return "expired";
  if (claims.nbf !== undefined && claims.nbf - LEEWAY_SECONDS > now) return "not yet valid";
  if (claims.repository !== expect.repository) return "wrong repository";
  if (claims.ref !== expect.ref) return "wrong ref";
  return claims;
}
