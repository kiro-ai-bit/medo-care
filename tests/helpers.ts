import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { generateKeyPair, exportJWK, SignJWT, importJWK } from "jose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Queryable } from "@kiro-ai-bit/eventing";
import * as schema from "@infrastructure/Persistence/schema/index.js";
import type { Db } from "@infrastructure/Persistence/db.js";
import { buildApp, type AppConfig, type BuiltApp } from "@webapi/bootstrap.js";
import type { JWK } from "jose";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

function wrap(pg: PGlite): Queryable {
  return {
    query: async <T = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) => {
      const res = await pg.query<T>(text, params as unknown[]);
      return { rows: res.rows };
    },
  };
}

export interface TestKeys {
  identityPrivateJwk: JWK; // signs USER tokens (iss=medo-identity)
  identityPublicJwk: JWK;
  careServicePrivateJwk: JWK; // medo-care outbound service JWTs
  peerServicePublicJwkByIss: Record<string, JWK[]>; // inbound service auth
}

export async function makeKeys(): Promise<TestKeys> {
  const ident = await generateKeyPair("ES256", { extractable: true });
  const svc = await generateKeyPair("ES256", { extractable: true });
  const ip = (await exportJWK(ident.publicKey)) as JWK;
  const is = (await exportJWK(ident.privateKey)) as JWK;
  const cp = (await exportJWK(svc.publicKey)) as JWK;
  const cs = (await exportJWK(svc.privateKey)) as JWK;
  for (const k of [ip, is, cp, cs]) {
    k.kid = "test-kid";
    k.alg = "ES256";
    k.use = "sig";
  }
  return {
    identityPrivateJwk: is,
    identityPublicJwk: ip,
    careServicePrivateJwk: cs,
    peerServicePublicJwkByIss: {
      "medo-identity": [cp],
      "medo-medicine": [cp],
      "medo-schedule-dose": [cp],
      "medo-notification": [cp],
      "medo-gamification": [cp],
    },
  };
}

export interface DirectoryStub {
  [userId: string]: {
    id: string;
    displayName: string;
    role: "Patient" | "Caregiver";
    email: string;
  };
}

export function makeConfig(
  keys: TestKeys,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return {
    port: 0,
    nodeEnv: "test",
    logLevel: "silent",
    databaseUrl: "pglite://",
    brokerDatabaseUrl: "pglite://",
    servicePrivateKey: keys.careServicePrivateJwk,
    servicePublicKeys: keys.peerServicePublicJwkByIss,
    identityServiceUrl: "http://identity.test",
    identityJwksUrl: "http://identity.test/.well-known/jwks.json",
    inviteTokenSecret: "test-invite-secret",
    inviteLinkBase: "https://app.test/invite/",
    sentryDsn: "",
    ...overrides,
  };
}

export interface TestApp extends BuiltApp {
  servicePg: PGlite;
  brokerPg: PGlite;
  config: AppConfig;
  keys: TestKeys;
  directoryStub: DirectoryStub;
  closeAll: () => Promise<void>;
}

// Stub fetch: JWKS URL → identity public JWK; directory URL → directory stub.
function makeFetchStub(
  keys: TestKeys,
  directory: DirectoryStub,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/.well-known/jwks.json")) {
      return new Response(
        JSON.stringify({ keys: [keys.identityPublicJwk] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const m = url.match(/\/v1\/users\/([0-9a-f-]{36})$/);
    if (m) {
      const entry = directory[m[1]];
      if (!entry)
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      return new Response(JSON.stringify(entry), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export async function createTestApp(
  opts: {
    configOverrides?: Partial<AppConfig>;
    directory?: DirectoryStub;
    startWorkers?: boolean;
  } = {},
): Promise<TestApp> {
  const keys = await makeKeys();
  const directory: DirectoryStub = opts.directory ?? {};
  const config = makeConfig(keys, opts.configOverrides);
  const fetchImpl = makeFetchStub(keys, directory);
  const servicePg = new PGlite();
  const brokerPg = new PGlite();
  const serviceDb = drizzlePglite(servicePg, { schema });
  await migratePglite(serviceDb, { migrationsFolder: MIGRATIONS });
  const db = serviceDb as unknown as Db;
  const built = await buildApp({
    config,
    db,
    careQueryable: wrap(servicePg),
    brokerQueryable: wrap(brokerPg),
    rateLimitOptions: {
      limits: { public: 100000, write: 100000, read: 100000 },
    },
    startWorkers: opts.startWorkers ?? false,
    fetchImpl,
  });
  return {
    ...built,
    servicePg,
    brokerPg,
    config,
    keys,
    directoryStub: directory,
    closeAll: async () => {
      await built.close();
      await servicePg.close();
      await brokerPg.close();
    },
  };
}

// Mint a USER JWT as Identity would (iss=medo-identity, aud=medo).
export async function mintUserToken(
  keys: TestKeys,
  opts: { sub: string; role: "Patient" | "Caregiver"; sid?: string },
): Promise<string> {
  const key = await importJWK(keys.identityPrivateJwk, "ES256");
  return new SignJWT({ role: opts.role, sid: opts.sid ?? "sess-1" })
    .setProtectedHeader({ alg: "ES256", kid: "test-kid", typ: "JWT" })
    .setIssuer("medo-identity")
    .setAudience("medo")
    .setSubject(opts.sub)
    .setIssuedAt()
    .setExpirationTime("25m")
    .sign(key as CryptoKey);
}

// Mint a SERVICE JWT as a peer caller (aud=medo-care by default).
export async function mintPeerServiceToken(
  keys: TestKeys,
  opts: { iss?: string; aud?: string } = {},
): Promise<string> {
  const key = await importJWK(keys.careServicePrivateJwk, "ES256");
  return new SignJWT({ role: "service" })
    .setProtectedHeader({ alg: "ES256", kid: "test-kid", typ: "JWT" })
    .setIssuer(opts.iss ?? "medo-identity")
    .setAudience(opts.aud ?? "medo-care")
    .setSubject("svc-test")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key as CryptoKey);
}

export const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
export const PATIENT2_ID = "44444444-4444-4444-8444-444444444444";
export const CAREGIVER_ID = "22222222-2222-4222-8222-222222222222";
export const CAREGIVER2_ID = "33333333-3333-4333-8333-333333333333";

export function seedDirectory(overrides: Partial<DirectoryStub> = {}): DirectoryStub {
  return {
    [PATIENT_ID]: {
      id: PATIENT_ID,
      displayName: "Patient One",
      role: "Patient",
      email: "patient@example.com",
    },
    [PATIENT2_ID]: {
      id: PATIENT2_ID,
      displayName: "Patient Two",
      role: "Patient",
      email: "patient2@example.com",
    },
    [CAREGIVER_ID]: {
      id: CAREGIVER_ID,
      displayName: "Caregiver One",
      role: "Caregiver",
      email: "caregiver@example.com",
    },
    [CAREGIVER2_ID]: {
      id: CAREGIVER2_ID,
      displayName: "Caregiver Two",
      role: "Caregiver",
      email: "caregiver2@example.com",
    },
    ...overrides,
  };
}
