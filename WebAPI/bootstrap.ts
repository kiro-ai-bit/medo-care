import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import {
  rateLimitPlugin,
  type RateLimitOptions,
} from "@kiro-ai-bit/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { JWK } from "jose";
import type { Db } from "@infrastructure/Persistence/db.js";
import type { Queryable } from "@kiro-ai-bit/eventing";
import type { ConsumerHandle, PublisherHandle } from "@kiro-ai-bit/eventing";
import {
  ensureCareEventing,
  startAccountDeletedConsumer,
  startCarePublisher,
} from "@infrastructure/Eventing/index.js";
import {
  createDirectoryCache,
  createIdentityDirectoryClient,
  createJwksCache,
  type DirectoryCache,
} from "@infrastructure/IdentityClient/directory.js";
import { registerErrorHandler } from "./Middleware/errors.js";
import { registerAuthn } from "./Middleware/authn.js";
import {
  createMetrics,
  registerRedHook,
  type MetricsImpl,
} from "./Middleware/metrics.js";
import { registerInviteRoutes } from "./Public/routes.js";
import { registerInternalRoutes } from "./Internal/routes.js";
import { registerPlatformRoutes } from "./Platform/routes.js";
import { handleAccountDeleted } from "@application/AccountDeletion/handleAccountDeleted.js";
import { registerInviteExpirySweep } from "@application/InviteExpirySweep/registerInviteExpirySweep.js";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BROKER_DATABASE_URL: z.string().min(1),
  SERVICE_PRIVATE_KEY: z.string().min(1),
  SERVICE_PUBLIC_KEYS: z.string().min(1),
  IDENTITY_SERVICE_URL: z.string().min(1),
  IDENTITY_JWKS_URL: z.string().min(1),
  INVITE_TOKEN_SECRET: z.string().min(1),
  INVITE_LINK_BASE: z.string().min(1),
  SENTRY_DSN: z.string().optional().default(""),
  PORT: z.coerce.number().int().positive().default(3002),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  brokerDatabaseUrl: string;
  servicePrivateKey: JWK;
  servicePublicKeys: Record<string, JWK[]>;
  identityServiceUrl: string;
  identityJwksUrl: string;
  inviteTokenSecret: string;
  inviteLinkBase: string;
  sentryDsn: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    brokerDatabaseUrl: e.BROKER_DATABASE_URL,
    servicePrivateKey: JSON.parse(e.SERVICE_PRIVATE_KEY) as JWK,
    servicePublicKeys: JSON.parse(e.SERVICE_PUBLIC_KEYS) as Record<
      string,
      JWK[]
    >,
    identityServiceUrl: e.IDENTITY_SERVICE_URL,
    identityJwksUrl: e.IDENTITY_JWKS_URL,
    inviteTokenSecret: e.INVITE_TOKEN_SECRET,
    inviteLinkBase: e.INVITE_LINK_BASE,
    sentryDsn: e.SENTRY_DSN,
  };
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  careQueryable: Queryable;
  brokerQueryable: Queryable;
  brokerDsn?: string;
  rateLimitOptions?: RateLimitOptions;
  startWorkers?: boolean;
  fetchImpl?: typeof fetch;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: Db;
  metrics: MetricsImpl;
  directory: DirectoryCache;
  publisher?: PublisherHandle;
  consumer?: ConsumerHandle;
  inviteExpiryRunOnce: () => Promise<{ expired: number }>;
  close: () => Promise<void>;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config } = deps;
  if (config.sentryDsn) {
    Sentry.init({ dsn: config.sentryDsn, environment: config.nodeEnv });
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && h.length > 0 ? h : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", String(request.id));
  });

  registerErrorHandler(app);

  const metrics = createMetrics();
  registerRedHook(app, metrics);

  const jwks = createJwksCache({
    jwksUrl: config.identityJwksUrl,
    fetchImpl: deps.fetchImpl,
  });
  const directory = createDirectoryCache(
    createIdentityDirectoryClient({
      baseUrl: config.identityServiceUrl,
      servicePrivateKeyJwk: config.servicePrivateKey,
      fetchImpl: deps.fetchImpl,
    }),
  );

  const coreDeps = {
    db: deps.db,
    inviteTokenSecret: config.inviteTokenSecret,
    inviteLinkBase: config.inviteLinkBase,
    directory,
    metrics,
  };
  const linkDeps = { db: deps.db, directory, metrics };

  // authN guard hook must run before rate-limit preHandler (rate-limit pkg contract)
  registerAuthn(app, {
    jwks,
    userIssuer: "medo-identity",
    userAudience: "medo",
    servicePublicKeys: config.servicePublicKeys,
    serviceAudience: "medo-care",
  });
  await app.register(rateLimitPlugin, deps.rateLimitOptions ?? {});

  registerInviteRoutes(app, { ...coreDeps, ...linkDeps });
  registerInternalRoutes(app, linkDeps);
  registerPlatformRoutes(app, {
    db: deps.db,
    broker: deps.brokerQueryable,
    metrics,
  });

  await ensureCareEventing({
    service: deps.careQueryable,
    broker: deps.brokerQueryable,
  });

  const publisher = deps.startWorkers
    ? await startCarePublisher({
        service: deps.careQueryable,
        broker: deps.brokerQueryable,
        brokerDsn: deps.brokerDsn,
        logger: { error: (m, meta) => app.log.error({ meta }, m) },
      })
    : undefined;

  const consumer = deps.startWorkers
    ? await startAccountDeletedConsumer({
        service: deps.careQueryable,
        broker: deps.brokerQueryable,
        brokerDsn: deps.brokerDsn,
        dispatch: (event) =>
          handleAccountDeleted(
            { db: deps.db, directory, metrics },
            { userId: event.userId as string },
          ),
        logger: { error: (m, meta) => app.log.error({ meta }, m) },
      })
    : undefined;

  const sweep = registerInviteExpirySweep({
    db: deps.db,
    metrics,
    reportError: (err) => {
      app.log.error({ err }, "invite-expiry-sweep tick failed");
      Sentry.captureException(err);
    },
  });

  return {
    app,
    db: deps.db,
    metrics,
    directory,
    publisher,
    consumer,
    inviteExpiryRunOnce: sweep.runOnce,
    close: async () => {
      sweep.task.stop();
      if (consumer) await consumer.stop();
      if (publisher) await publisher.stop();
      await app.close();
    },
  };
}
