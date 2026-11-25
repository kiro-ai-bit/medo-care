import type { FastifyInstance } from "fastify";
import {
  AcceptInviteResponseSchema,
  CancelInviteResponseSchema,
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  DeclineInviteResponseSchema,
  EndLinkResponseSchema,
  InviteIdParamsSchema,
  InviteListResponseSchema,
  InvitePreviewDtoSchema,
  InviteTokenParamsSchema,
  LinkIdParamsSchema,
  LinkListResponseSchema,
  ResendInviteResponseSchema,
} from "@kiro-ai-bit/contracts";
import {
  acceptInvite,
  cancelInvite,
  createInvite,
  declineInvite,
  listInvites,
  previewInvite,
  resendInvite,
  type InviteDeps,
} from "@core/Invite/invite.js";
import {
  endLink,
  listLinks,
  type LinkDeps,
} from "@core/Link/link.js";
import { ForbiddenError } from "../Middleware/errors.js";

function requireUser(request: { user?: { sub: string; role: string } }) {
  if (!request.user) throw new ForbiddenError("authentication required");
  return request.user as never;
}

export function registerInviteRoutes(
  app: FastifyInstance,
  deps: InviteDeps & LinkDeps,
): void {
  const d = deps as InviteDeps & LinkDeps;

  app.post(
    "/v1/care/links/invites",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        body: CreateInviteRequestSchema,
        response: { 201: CreateInviteResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as { caregiverEmail: string };
      const result = await createInvite(d, requireUser(request), body.caregiverEmail);
      return reply.code(201).send(result);
    },
  );

  app.get(
    "/v1/care/invites/:token",
    {
      config: { rateLimit: "public" },
      schema: {
        params: InviteTokenParamsSchema,
        response: { 200: InvitePreviewDtoSchema },
      },
    },
    async (request) => {
      const { token } = request.params as { token: string };
      return previewInvite(d, token);
    },
  );

  app.post(
    "/v1/care/invites/:token/accept",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: InviteTokenParamsSchema,
        response: { 201: AcceptInviteResponseSchema },
      },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const result = await acceptInvite(d, token, requireUser(request));
      return reply.code(201).send(result);
    },
  );

  app.post(
    "/v1/care/invites/:token/decline",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: InviteTokenParamsSchema,
        response: { 200: DeclineInviteResponseSchema },
      },
    },
    async (request) => {
      const { token } = request.params as { token: string };
      return declineInvite(d, token, requireUser(request));
    },
  );

  app.post(
    "/v1/care/invites/:id/resend",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: InviteIdParamsSchema,
        response: { 200: ResendInviteResponseSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return resendInvite(d, id, requireUser(request));
    },
  );

  app.post(
    "/v1/care/invites/:id/cancel",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: InviteIdParamsSchema,
        response: { 200: CancelInviteResponseSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return cancelInvite(d, id, requireUser(request));
    },
  );

  app.get(
    "/v1/care/invites",
    {
      config: { auth: "user", rateLimit: "read" },
      schema: { response: { 200: InviteListResponseSchema } },
    },
    async (request) => listInvites(d, requireUser(request)),
  );

  app.get(
    "/v1/care/links",
    {
      config: { auth: "user", rateLimit: "read" },
      schema: { response: { 200: LinkListResponseSchema } },
    },
    async (request) => listLinks(d, requireUser(request)),
  );

  app.post(
    "/v1/care/links/:id/end",
    {
      config: { auth: "user", rateLimit: "write" },
      schema: {
        params: LinkIdParamsSchema,
        response: { 200: EndLinkResponseSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return endLink(d, id, requireUser(request));
    },
  );
}
