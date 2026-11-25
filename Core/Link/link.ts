import type { Db, DbTx } from "@infrastructure/Persistence/db.js";
import { createLinksRepo } from "@infrastructure/Persistence/repositories.js";
import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import type { LinkRow } from "@infrastructure/Persistence/schema/index.js";
import {
  ConflictError,
  DependencyError,
  ForbiddenError,
  NotFoundError,
} from "@core/errors.js";
import type { UserClaims } from "@core/types.js";
import type { Metrics } from "@core/metrics.js";
import type { DirectoryEntryDto } from "@infrastructure/IdentityClient/directory.js";

export interface LinkDeps {
  db: Db;
  directory: {
    getDirectoryEntry: (userId: string) => Promise<DirectoryEntryDto | null>;
  };
  metrics?: Metrics;
}

// FR-CAR-009 — insert active link inside accept tx (partial-unique backstop).
export async function createLinkForAccept(
  tx: DbTx,
  patientId: string,
  caregiverId: string,
  caregiverEmail: string,
): Promise<LinkRow> {
  return createLinksRepo(tx as unknown as Db).insert({
    patientId,
    caregiverId,
    caregiverEmail,
    status: "active",
  });
}

// FR-CAR-021 — active links where caller is patient or caregiver.
export async function listLinks(
  deps: LinkDeps,
  actor: UserClaims,
): Promise<{
  links: {
    linkId: string;
    direction: "as-patient" | "as-caregiver";
    counterpart: { userId: string; displayName: string };
    createdAt: string;
  }[];
}> {
  const links = await createLinksRepo(deps.db).listActiveForUser(actor.sub);
  const items = [];
  for (const link of links) {
    const isPatient = link.patientId === actor.sub;
    const counterpartId = isPatient ? link.caregiverId : link.patientId;
    const counterpart = await deps.directory.getDirectoryEntry(counterpartId);
    if (!counterpart) throw new DependencyError("directory unavailable");
    items.push({
      linkId: link.id,
      direction: isPatient ? ("as-patient" as const) : ("as-caregiver" as const),
      counterpart: { userId: counterpartId, displayName: counterpart.displayName },
      createdAt: link.createdAt.toISOString(),
    });
  }
  return { links: items };
}

// FR-CAR-022 — either party ends; repeat → 409, non-party → 403.
export async function endLink(
  deps: LinkDeps,
  linkId: string,
  actor: UserClaims,
): Promise<{ linkId: string; status: "ended"; endedAt: string }> {
  const links = createLinksRepo(deps.db);
  const link = await links.findById(linkId);
  if (!link) throw new NotFoundError();
  if (link.status !== "active") throw new ConflictError("link already ended");
  if (link.patientId !== actor.sub && link.caregiverId !== actor.sub) {
    throw new ForbiddenError("not a party to this link");
  }
  return deps.db.transaction(async (tx) => {
    const ended = await createLinksRepo(tx as unknown as Db).endLink(
      linkId,
      actor.sub,
    );
    if (!ended) throw new ConflictError("link already ended");
    await appendOutbox(tx, {
      type: "CareLinkEnded",
      payload: {
        linkId: ended.id,
        patientId: ended.patientId,
        caregiverId: ended.caregiverId,
        endedBy: actor.sub,
      },
    });
    deps.metrics?.incr("medo_care_links_total", { action: "ended" });
    return {
      linkId: ended.id,
      status: "ended" as const,
      endedAt: (ended.endedAt ?? new Date()).toISOString(),
    };
  });
}

// FR-CAR-023 — live check-link; NEVER cached (LD-CARE-11).
export async function checkLink(
  deps: LinkDeps,
  patientId: string,
  caregiverId: string,
): Promise<{ active: boolean }> {
  const links = createLinksRepo(deps.db);
  const link = await links.findActiveByPair(patientId, caregiverId);
  deps.metrics?.incr("medo_care_checklink_calls_total", {
    result: link ? "active" : "inactive",
  });
  return { active: link !== null };
}

// FR-CAR-024 — internal patient link inventory (minimal payload).
export async function listPatientLinks(
  deps: LinkDeps,
  patientId: string,
): Promise<{ links: { linkId: string; caregiverId: string }[] }> {
  const links = await createLinksRepo(deps.db).listActiveForPatient(patientId);
  return {
    links: links.map((l) => ({ linkId: l.id, caregiverId: l.caregiverId })),
  };
}

export { createLinksRepo };
