import type { Db, DbTx } from "@infrastructure/Persistence/db.js";
import {
  createInvitesRepo,
  createLinksRepo,
} from "@infrastructure/Persistence/repositories.js";
import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import type { InviteRow } from "@infrastructure/Persistence/schema/index.js";
import {
  buildInviteLink,
  deriveInviteToken,
  hashInviteToken,
} from "@core/Tokens/inviteToken.js";
import {
  createLinkForAccept,
} from "@core/Link/link.js";
import {
  ConflictError,
  DependencyError,
  ForbiddenError,
  NotFoundError,
} from "@core/errors.js";
import type { UserClaims } from "@core/types.js";
import type { Metrics } from "@core/metrics.js";
import type { DirectoryEntryDto } from "@infrastructure/IdentityClient/directory.js";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RESEND_CAP = 3;

export interface InviteDeps {
  db: Db;
  inviteTokenSecret: string;
  inviteLinkBase: string;
  directory: {
    getDirectoryEntry: (userId: string) => Promise<DirectoryEntryDto | null>;
  };
  metrics?: Metrics;
  now?: () => Date;
}

function now(deps: InviteDeps): Date {
  return deps.now?.() ?? new Date();
}

function invitePayload(
  invite: InviteRow,
  deps: InviteDeps,
): Record<string, unknown> {
  const raw = deriveInviteToken(invite.id, deps.inviteTokenSecret);
  return {
    inviteId: invite.id,
    patientId: invite.patientId,
    caregiverEmail: invite.caregiverEmail,
    inviteLink: buildInviteLink(raw, deps.inviteLinkBase),
    expiresAt: invite.expiresAt.toISOString(),
  };
}

// FR-CAR-001/002/003 — patient-session create; directory-free (HD-CARE-06).
export async function createInvite(
  deps: InviteDeps,
  actor: UserClaims,
  caregiverEmailRaw: string,
): Promise<{
  inviteId: string;
  caregiverEmail: string;
  expiresAt: string;
  status: "pending";
}> {
  if (actor.role !== "Patient") throw new ForbiddenError("patient role required");
  const caregiverEmail = caregiverEmailRaw.trim().toLowerCase();
  const t = now(deps);

  return deps.db.transaction(async (tx) => {
    const invitesTx = createInvitesRepo(tx as unknown as Db);
    const linksTx = createLinksRepo(tx as unknown as Db);
    if (await invitesTx.existsPending(actor.sub, caregiverEmail)) {
      throw new ConflictError("pending invite already exists");
    }
    if (await linksTx.findActiveByEmail(actor.sub, caregiverEmail)) {
      throw new ConflictError("active link already exists for this email");
    }
    // Insert first to obtain id, then derive+store token_hash same tx (LLD §8.1).
    const invite = await invitesTx.insert({
      patientId: actor.sub,
      caregiverEmail,
      tokenHash: "pending",
      status: "pending",
      expiresAt: new Date(t.getTime() + INVITE_TTL_MS),
      resendTimestamps: [],
    });
    const raw = deriveInviteToken(invite.id, deps.inviteTokenSecret);
    await invitesTx.updateTokenHash(invite.id, hashInviteToken(raw));
    invite.tokenHash = hashInviteToken(raw);
    await appendOutbox(tx, {
      type: "CareLinkInviteCreated",
      payload: invitePayload(invite, deps),
    });
    deps.metrics?.incr("medo_care_invites_total", { action: "created" });
    return {
      inviteId: invite.id,
      caregiverEmail,
      expiresAt: invite.expiresAt.toISOString(),
      status: "pending" as const,
    };
  });
}

// Shared request-time expiry (LLD §8.3) — guarded UPDATE + outbox, once.
async function expirePendingInvite(
  deps: InviteDeps,
  tx: DbTx,
  inviteId: string,
  patientId: string,
): Promise<void> {
  const expired = await createInvitesRepo(tx as unknown as Db).expireIfDue(
    inviteId,
    now(deps),
  );
  if (expired) {
    await appendOutbox(tx, {
      type: "CareLinkInviteExpired",
      payload: { inviteId, patientId },
    });
    deps.metrics?.incr("medo_care_invites_total", { action: "expired" });
  }
}

// Resolve raw token → pending unexpired invite; runs request-time expiry first.
async function resolveLiveInvite(
  deps: InviteDeps,
  rawToken: string,
): Promise<InviteRow> {
  const invites = createInvitesRepo(deps.db);
  const invite = await invites.findByTokenHash(hashInviteToken(rawToken));
  if (!invite || invite.status !== "pending") throw new NotFoundError();
  if (invite.expiresAt.getTime() <= now(deps).getTime()) {
    await deps.db.transaction(async (tx) => {
      await expirePendingInvite(deps, tx, invite.id, invite.patientId);
    });
    throw new NotFoundError();
  }
  return invite;
}

// FR-CAR-006/007/008 — public preview; directory-dependent (HD-CARE-06).
export async function previewInvite(
  deps: InviteDeps,
  rawToken: string,
): Promise<{ patientDisplayName: string; expiresAt: string }> {
  const invite = await resolveLiveInvite(deps, rawToken);
  const patient = await deps.directory.getDirectoryEntry(invite.patientId);
  if (!patient) throw new DependencyError("directory unavailable");
  return {
    patientDisplayName: patient.displayName,
    expiresAt: invite.expiresAt.toISOString(),
  };
}

// Shared pre-tx authz for accept/decline (HD-CARE-05).
async function authorizeInviteActor(
  deps: InviteDeps,
  invite: InviteRow,
  actor: UserClaims,
): Promise<void> {
  if (actor.role !== "Caregiver") throw new ForbiddenError("caregiver role required");
  const me = await deps.directory.getDirectoryEntry(actor.sub);
  if (!me) throw new DependencyError("directory unavailable");
  if (
    me.role !== "Caregiver" ||
    me.email.toLowerCase() !== invite.caregiverEmail
  ) {
    throw new ForbiddenError("invite not addressed to this caregiver");
  }
}

// FR-CAR-009…012/014 — accept: session+email-match → link + CareLinkCreated.
export async function acceptInvite(
  deps: InviteDeps,
  rawToken: string,
  actor: UserClaims,
): Promise<{
  linkId: string;
  patientId: string;
  caregiverId: string;
  createdAt: string;
}> {
  const invite = await resolveLiveInvite(deps, rawToken);
  await authorizeInviteActor(deps, invite, actor);
  const patient = await deps.directory.getDirectoryEntry(invite.patientId);
  if (!patient) throw new ConflictError("patient no longer exists");

  return deps.db.transaction(async (tx) => {
    const transitioned = await createInvitesRepo(
      tx as unknown as Db,
    ).transitionInvite(invite.id, "pending", "accepted");
    if (!transitioned) throw new NotFoundError();
    let link;
    try {
      link = await createLinkForAccept(
        tx,
        invite.patientId,
        actor.sub,
        invite.caregiverEmail,
      );
    } catch (err) {
      // only the partial-unique (patient_id,caregiver_id) active violation → 409
      const code =
        (err as { code?: string }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") {
        throw new ConflictError("active link already exists");
      }
      throw err;
    }
    await appendOutbox(tx, {
      type: "CareLinkCreated",
      payload: {
        linkId: link.id,
        patientId: invite.patientId,
        caregiverId: actor.sub,
      },
    });
    deps.metrics?.incr("medo_care_invites_total", { action: "accepted" });
    deps.metrics?.incr("medo_care_links_total", { action: "created" });
    return {
      linkId: link.id,
      patientId: invite.patientId,
      caregiverId: actor.sub,
      createdAt: link.createdAt.toISOString(),
    };
  });
}

// FR-CAR-013/014 — decline: silent, no link.
export async function declineInvite(
  deps: InviteDeps,
  rawToken: string,
  actor: UserClaims,
): Promise<{ inviteId: string; status: "declined" }> {
  const invite = await resolveLiveInvite(deps, rawToken);
  await authorizeInviteActor(deps, invite, actor);
  return deps.db.transaction(async (tx) => {
    const transitioned = await createInvitesRepo(
      tx as unknown as Db,
    ).transitionInvite(invite.id, "pending", "declined");
    if (!transitioned) throw new NotFoundError();
    await appendOutbox(tx, {
      type: "CareLinkInviteDeclined",
      payload: {
        inviteId: invite.id,
        patientId: invite.patientId,
        caregiverId: actor.sub,
      },
    });
    deps.metrics?.incr("medo_care_invites_total", { action: "declined" });
    return { inviteId: invite.id, status: "declined" as const };
  });
}

// FR-CAR-015/017 — resend: patient-owned pending+unexpired, rolling-24h cap 3.
export async function resendInvite(
  deps: InviteDeps,
  inviteId: string,
  actor: UserClaims,
): Promise<{ inviteId: string; expiresAt: string }> {
  if (actor.role !== "Patient") throw new ForbiddenError("patient role required");
  const invites = createInvitesRepo(deps.db);
  const invite = await invites.findById(inviteId);
  const t = now(deps);
  if (!invite || invite.patientId !== actor.sub) throw new NotFoundError();
  if (invite.status !== "pending") throw new NotFoundError();
  if (invite.expiresAt.getTime() <= t.getTime()) {
    await deps.db.transaction(async (tx) => {
      await expirePendingInvite(deps, tx, invite.id, invite.patientId);
    });
    throw new NotFoundError();
  }
  const window = invite.resendTimestamps.filter(
    (ts) => ts.getTime() > t.getTime() - RESEND_WINDOW_MS,
  );
  if (window.length >= RESEND_CAP) {
    deps.metrics?.incr("medo_care_invites_total", {
      action: "resend_rejected",
    });
    throw new ConflictError("resend cap reached");
  }
  return deps.db.transaction(async (tx) => {
    const appended = await createInvitesRepo(
      tx as unknown as Db,
    ).appendResendTimestamp(invite.id, t);
    if (!appended) throw new NotFoundError(); // lost race to accept/decline
    await appendOutbox(tx, {
      type: "CareLinkInviteCreated",
      payload: invitePayload(invite, deps),
    });
    return { inviteId: invite.id, expiresAt: invite.expiresAt.toISOString() };
  });
}

// FR-CAR-016/017 — cancel: patient-owned pending → cancelled, silent.
export async function cancelInvite(
  deps: InviteDeps,
  inviteId: string,
  actor: UserClaims,
): Promise<{ inviteId: string; status: "cancelled" }> {
  if (actor.role !== "Patient") throw new ForbiddenError("patient role required");
  const invite = await createInvitesRepo(deps.db).findById(inviteId);
  if (!invite || invite.patientId !== actor.sub) throw new NotFoundError();
  if (invite.status === "pending" && invite.expiresAt.getTime() <= now(deps).getTime()) {
    await deps.db.transaction(async (tx) => {
      await expirePendingInvite(deps, tx, invite.id, invite.patientId);
    });
    throw new NotFoundError();
  }
  return deps.db.transaction(async (tx) => {
    const transitioned = await createInvitesRepo(
      tx as unknown as Db,
    ).transitionInvite(invite.id, "pending", "cancelled");
    if (!transitioned) throw new ConflictError("invite not pending");
    deps.metrics?.incr("medo_care_invites_total", { action: "cancelled" });
    return { inviteId: invite.id, status: "cancelled" as const };
  });
}

// FR-CAR-028 — caller-scoped pending invites both directions.
export async function listInvites(
  deps: InviteDeps,
  actor: UserClaims,
): Promise<{
  invites: {
    inviteId: string;
    direction: "sent" | "received";
    counterpartyEmail?: string;
    counterpartyDisplayName?: string;
    expiresAt: string;
    createdAt: string;
  }[];
}> {
  const invites = createInvitesRepo(deps.db);
  const sent = await invites.listPendingForPatient(actor.sub);
  // Caregiver side resolves own email via directory (JWT carries no email claim).
  let actorEmail = "";
  if (actor.role === "Caregiver") {
    const me = await deps.directory.getDirectoryEntry(actor.sub);
    if (!me) throw new DependencyError("directory unavailable");
    actorEmail = me.email.toLowerCase();
  }
  const received = await invites.listPendingForEmail(actorEmail);
  const items: {
    inviteId: string;
    direction: "sent" | "received";
    counterpartyEmail?: string;
    counterpartyDisplayName?: string;
    expiresAt: string;
    createdAt: string;
  }[] = [];
  for (const inv of sent) {
    items.push({
      inviteId: inv.id,
      direction: "sent",
      counterpartyEmail: inv.caregiverEmail,
      expiresAt: inv.expiresAt.toISOString(),
      createdAt: inv.createdAt.toISOString(),
    });
  }
  for (const inv of received) {
    const patient = await deps.directory.getDirectoryEntry(inv.patientId);
    if (!patient) throw new DependencyError("directory unavailable");
    items.push({
      inviteId: inv.id,
      direction: "received",
      counterpartyDisplayName: patient.displayName,
      expiresAt: inv.expiresAt.toISOString(),
      createdAt: inv.createdAt.toISOString(),
    });
  }
  return { invites: items };
}

// FR-CAR-004/018 — request-time expiry used by token paths + sweep.
export async function expireInviteIfDue(
  deps: InviteDeps,
  inviteId: string,
): Promise<boolean> {
  const invite = await createInvitesRepo(deps.db).findById(inviteId);
  if (!invite) return false;
  return deps.db.transaction(async (tx) => {
    const before = await createInvitesRepo(tx as unknown as Db).findById(inviteId);
    if (!before || before.status !== "pending") return false;
    await expirePendingInvite(deps, tx, inviteId, invite.patientId);
    return true;
  });
}
