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

export const careLinks = pgTable(
  "care_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id").notNull(),
    caregiverId: uuid("caregiver_id").notNull(),
    caregiverEmail: text("caregiver_email").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: uuid("ended_by"),
  },
  (t) => [
    uniqueIndex("uq_links_active_pair")
      .on(t.patientId, t.caregiverId)
      .where(sql`${t.status} = 'active'`),
    index("idx_links_patient_status").on(t.patientId, t.status),
    index("idx_links_caregiver_status").on(t.caregiverId, t.status),
    index("idx_links_active_email")
      .on(t.patientId, t.caregiverEmail)
      .where(sql`${t.status} = 'active'`),
    check("links_email_lower", sql`${t.caregiverEmail} = lower(${t.caregiverEmail})`),
    check("links_status_enum", sql`${t.status} IN ('active','ended')`),
    check(
      "links_ended_consistency",
      sql`(${t.status} = 'ended') = (${t.endedAt} IS NOT NULL)`,
    ),
  ],
);

export type LinkRow = typeof careLinks.$inferSelect;
export type NewLinkRow = typeof careLinks.$inferInsert;
