import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const careLinkInvites = pgTable(
  "care_link_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id").notNull(),
    caregiverEmail: text("caregiver_email").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resendTimestamps: timestamp("resend_timestamps", {
      withTimezone: true,
    })
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("care_link_invites_token_hash_key").on(t.tokenHash),
    index("idx_invites_patient_status").on(t.patientId, t.status),
    index("idx_invites_email_status").on(t.caregiverEmail, t.status),
    index("idx_invites_status_expires").on(t.status, t.expiresAt),
    check(
      "invites_email_lower",
      sql`${t.caregiverEmail} = lower(${t.caregiverEmail})`,
    ),
    check(
      "invites_status_enum",
      sql`${t.status} IN ('pending','accepted','declined','expired','cancelled')`,
    ),
  ],
);

export type InviteRow = typeof careLinkInvites.$inferSelect;
export type NewInviteRow = typeof careLinkInvites.$inferInsert;
export type InviteStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "expired"
  | "cancelled";
