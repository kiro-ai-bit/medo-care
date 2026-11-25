import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkLink, listPatientLinks, type LinkDeps } from "@core/Link/link.js";

const uuid = z.uuid();

const checkLinkQuerySchema = z.strictObject({
  patientId: uuid,
  caregiverId: uuid,
});
const checkLinkResponseSchema = z.strictObject({ active: z.boolean() });
const patientLinksParamsSchema = z.strictObject({ id: uuid });
const patientLinksResponseSchema = z.strictObject({
  links: z.array(z.strictObject({ linkId: uuid, caregiverId: uuid })),
});

export function registerInternalRoutes(
  app: FastifyInstance,
  deps: LinkDeps,
): void {
  app.get(
    "/v1/care/check-link",
    {
      config: { auth: "service", rateLimit: "internal" },
      schema: {
        querystring: checkLinkQuerySchema,
        response: { 200: checkLinkResponseSchema },
      },
    },
    async (request) => {
      const q = request.query as { patientId: string; caregiverId: string };
      return checkLink(deps, q.patientId, q.caregiverId);
    },
  );

  app.get(
    "/v1/care/patients/:id/links",
    {
      config: { auth: "service", rateLimit: "internal" },
      schema: {
        params: patientLinksParamsSchema,
        response: { 200: patientLinksResponseSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return listPatientLinks(deps, id);
    },
  );
}
