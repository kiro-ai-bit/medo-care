import { importJWK, SignJWT } from "jose";
import type { JWK } from "jose";

export interface DirectoryEntryDto {
  id: string;
  displayName: string;
  role: "Patient" | "Caregiver";
  email: string;
}

const SERVICE_TOKEN_TTL_SEC = 5 * 60;
const REQUEST_TIMEOUT_MS = 3000;
const RETRY_DELAY_MS = 200;
const CACHE_TTL_MS = 60_000;

export interface DirectoryClient {
  getDirectoryEntry: (userId: string) => Promise<DirectoryEntryDto | null>;
}

// Thrown when Identity is unreachable — mapped to 503 DEPENDENCY_UNAVAILABLE
// by the WebAPI error handler (HD-CARE-06 fail-closed policy).
export class DirectoryUnavailableError extends Error {
  constructor(message = "identity directory unavailable") {
    super(message);
    this.name = "DirectoryUnavailableError";
  }
}

export function createIdentityDirectoryClient(deps: {
  baseUrl: string;
  servicePrivateKeyJwk: JWK;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): DirectoryClient {
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const alg = (deps.servicePrivateKeyJwk.alg as string | undefined) ?? "ES256";
  let privateKey: CryptoKey | null = null;

  async function serviceToken(): Promise<string> {
    if (!privateKey) {
      privateKey = (await importJWK(
        deps.servicePrivateKeyJwk,
        alg,
      )) as CryptoKey;
    }
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: "service" })
      .setProtectedHeader({
        alg,
        kid: deps.servicePrivateKeyJwk.kid,
        typ: "JWT",
      })
      .setIssuer("medo-care")
      .setAudience("medo-identity")
      .setSubject("medo-care")
      .setIssuedAt(iat)
      .setExpirationTime(iat + SERVICE_TOKEN_TTL_SEC)
      .sign(privateKey);
  }

  async function attempt(userId: string): Promise<Response | null> {
    const token = await serviceToken();
    const fetchImpl = deps.fetchImpl ?? fetch;
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetchImpl(`${deps.baseUrl}/v1/users/${userId}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return res;
        if (res.status < 500) return null; // permanent — 404 etc.
      } catch {
        // transient — retry once
      }
      if (i === 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    throw new DirectoryUnavailableError();
  }

  return {
    async getDirectoryEntry(userId: string): Promise<DirectoryEntryDto | null> {
      const res = await attempt(userId);
      if (!res) return null;
      return (await res.json()) as DirectoryEntryDto;
    },
  };
}

// directoryCache — in-process Map, 60s TTL, AccountDeleted invalidation (LD-CARE-06).
export function createDirectoryCache(client: DirectoryClient) {
  const map = new Map<
    string,
    { dto: DirectoryEntryDto | null; expiresAt: number }
  >();
  return {
    async getDirectoryEntry(userId: string): Promise<DirectoryEntryDto | null> {
      const hit = map.get(userId);
      if (hit && hit.expiresAt > Date.now()) return hit.dto;
      const dto = await client.getDirectoryEntry(userId);
      map.set(userId, { dto, expiresAt: Date.now() + CACHE_TTL_MS });
      return dto;
    },
    invalidate(userId: string): void {
      map.delete(userId);
    },
    invalidateAll(): void {
      map.clear();
    },
  };
}

export type DirectoryCache = ReturnType<typeof createDirectoryCache>;

// jwksCache — Identity JWKS fetch, 300s cache, refetch on unknown kid (§11).
export function createJwksCache(deps: {
  jwksUrl: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
}) {
  const ttlMs = deps.ttlMs ?? 300_000;
  let cached: { keys: JWK[]; expiresAt: number } | null = null;
  return {
    async get(forceRefresh = false) {
      if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
        return cached.keys;
      }
      const fetchImpl = deps.fetchImpl ?? fetch;
      const res = await fetchImpl(deps.jwksUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      const jwks = (await res.json()) as { keys: JWK[] };
      cached = { keys: jwks.keys, expiresAt: Date.now() + ttlMs };
      return cached.keys;
    },
  };
}

export type JwksCache = ReturnType<typeof createJwksCache>;
