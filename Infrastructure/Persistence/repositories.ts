import { and, eq, lte, sql } from "drizzle-orm";
import { careLinkInvites, careLinks } from "./schema/index.js";
import type {
  InviteRow,
  InviteStatus,
  LinkRow,
  NewInviteRow,
  NewLinkRow,
} from "./schema/index.js";
import type { Db } from "./db.js";

// Repos bind to any drizzle executor — pass the tx object (cast as Db) for
// in-transaction work; PGlite is single-connection so mixing db+tx deadlocks.
export function createInvitesRepo(db: Db) {
  return {
    async findById(id: string): Promise<InviteRow | null> {
      const rows = await db
        .select()
        .from(careLinkInvites)
        .where(eq(careLinkInvites.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
    async findByTokenHash(tokenHash: string): Promise<InviteRow | null> {
      const rows = await db
        .select()
        .from(careLinkInvites)
        .where(eq(careLinkInvites.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },
    async insert(invite: NewInviteRow): Promise<InviteRow> {
      const rows = await db.insert(careLinkInvites).values(invite).returning();
      return rows[0];
    },
    async updateTokenHash(id: string, tokenHash: string): Promise<void> {
      await db
        .update(careLinkInvites)
        .set({ tokenHash })
        .where(eq(careLinkInvites.id, id));
    },
    async existsPending(
      patientId: string,
      caregiverEmail: string,
    ): Promise<boolean> {
      const rows = await db
        .select({ id: careLinkInvites.id })
        .from(careLinkInvites)
        .where(
          and(
            eq(careLinkInvites.patientId, patientId),
            eq(careLinkInvites.caregiverEmail, caregiverEmail),
            eq(careLinkInvites.status, "pending"),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async listPendingForPatient(patientId: string): Promise<InviteRow[]> {
      return db
        .select()
        .from(careLinkInvites)
        .where(
          and(
            eq(careLinkInvites.patientId, patientId),
            eq(careLinkInvites.status, "pending"),
          ),
        );
    },
    async listPendingForEmail(caregiverEmail: string): Promise<InviteRow[]> {
      return db
        .select()
        .from(careLinkInvites)
        .where(
          and(
            eq(careLinkInvites.caregiverEmail, caregiverEmail),
            eq(careLinkInvites.status, "pending"),
          ),
        );
    },
    // Guarded status transition — atomic single-use/terminal guard (LD-CARE-04).
    async transitionInvite(
      inviteId: string,
      from: InviteStatus,
      to: InviteStatus,
    ): Promise<InviteRow | null> {
      const rows = await db
        .update(careLinkInvites)
        .set({
          status: to,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(careLinkInvites.id, inviteId),
            eq(careLinkInvites.status, from),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
    // Guarded resend append — pending-only so a racing accept/decline wins (LD-CARE-04).
    async appendResendTimestamp(
      inviteId: string,
      ts: Date,
    ): Promise<InviteRow | null> {
      const rows = await db
        .update(careLinkInvites)
        .set({
          resendTimestamps: sql`${careLinkInvites.resendTimestamps} || ${ts}::timestamptz`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(careLinkInvites.id, inviteId),
            eq(careLinkInvites.status, "pending"),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
    // Request-time/sweep expiry — guarded UPDATE, exactly once (LLD §8.3).
    async expireIfDue(inviteId: string, now: Date): Promise<InviteRow | null> {
      const rows = await db
        .update(careLinkInvites)
        .set({
          status: "expired",
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(careLinkInvites.id, inviteId),
            eq(careLinkInvites.status, "pending"),
            lte(careLinkInvites.expiresAt, now),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
    async findPendingExpired(now: Date): Promise<InviteRow[]> {
      return db
        .select()
        .from(careLinkInvites)
        .where(
          and(
            eq(careLinkInvites.status, "pending"),
            lte(careLinkInvites.expiresAt, now),
          ),
        );
    },
    async cancelPendingForPatient(patientId: string): Promise<void> {
      await db
        .update(careLinkInvites)
        .set({
          status: "cancelled",
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(careLinkInvites.patientId, patientId),
            eq(careLinkInvites.status, "pending"),
          ),
        );
    },
    async deleteByPatientId(patientId: string): Promise<void> {
      await db
        .delete(careLinkInvites)
        .where(eq(careLinkInvites.patientId, patientId));
    },
  };
}

export function createLinksRepo(db: Db) {
  return {
    async insert(link: NewLinkRow): Promise<LinkRow> {
      const rows = await db.insert(careLinks).values(link).returning();
      return rows[0];
    },
    async findById(id: string): Promise<LinkRow | null> {
      const rows = await db
        .select()
        .from(careLinks)
        .where(eq(careLinks.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
    async findActiveByPair(
      patientId: string,
      caregiverId: string,
    ): Promise<LinkRow | null> {
      const rows = await db
        .select()
        .from(careLinks)
        .where(
          and(
            eq(careLinks.patientId, patientId),
            eq(careLinks.caregiverId, caregiverId),
            eq(careLinks.status, "active"),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async findActiveByEmail(
      patientId: string,
      caregiverEmail: string,
    ): Promise<LinkRow | null> {
      const rows = await db
        .select()
        .from(careLinks)
        .where(
          and(
            eq(careLinks.patientId, patientId),
            eq(careLinks.caregiverEmail, caregiverEmail),
            eq(careLinks.status, "active"),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async listActiveForUser(userId: string): Promise<LinkRow[]> {
      return db
        .select()
        .from(careLinks)
        .where(
          and(
            eq(careLinks.status, "active"),
            sql`(${careLinks.patientId} = ${userId} OR ${careLinks.caregiverId} = ${userId})`,
          ),
        );
    },
    async listActiveForPatient(patientId: string): Promise<LinkRow[]> {
      return db
        .select()
        .from(careLinks)
        .where(
          and(
            eq(careLinks.patientId, patientId),
            eq(careLinks.status, "active"),
          ),
        );
    },
    // Guarded end — 0 rows when already ended (LD-CARE-04).
    async endLink(linkId: string, endedBy: string): Promise<LinkRow | null> {
      const rows = await db
        .update(careLinks)
        .set({ status: "ended", endedAt: new Date(), endedBy })
        .where(and(eq(careLinks.id, linkId), eq(careLinks.status, "active")))
        .returning();
      return rows[0] ?? null;
    },
    async findInvolvingUserActive(userId: string): Promise<LinkRow[]> {
      return db
        .select()
        .from(careLinks)
        .where(
          and(
            eq(careLinks.status, "active"),
            sql`(${careLinks.patientId} = ${userId} OR ${careLinks.caregiverId} = ${userId})`,
          ),
        );
    },
    async deleteInvolvingUser(userId: string): Promise<void> {
      await db
        .delete(careLinks)
        .where(
          sql`${careLinks.patientId} = ${userId} OR ${careLinks.caregiverId} = ${userId}`,
        );
    },
  };
}
