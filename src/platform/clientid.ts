import { clientAddress } from "./freecalls";

// Stable anonymous client id, to see whether a caller comes back on another
// day (e.g. after its free MCP calls). It is a truncated HMAC-SHA-256 of the
// address (IPv6 by its /64) under a secret key: without the key, a plain hash
// of an IPv4 address could be reversed by trying every address. Returns null
// when no key is configured.

let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (!cached || cached.secret !== secret) {
    const key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    cached = { secret, key };
  }
  return cached.key;
}

export async function clientId(ip: string | undefined, secret: string | undefined): Promise<string | null> {
  if (!ip || !secret) return null;
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(clientAddress(ip)));
  return [...new Uint8Array(mac).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Requests whose callers are worth following across days: the data API and
// MCP (also posted to "/"); page views are left out
export const tracksClient = (method: string, path: string) =>
  path.startsWith("/v1/") || path === "/mcp" || (method === "POST" && path === "/");
