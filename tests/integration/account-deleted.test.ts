import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  CAREGIVER_ID,
  PATIENT_ID,
  createTestApp,
  seedDirectory,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ directory: seedDirectory() });
});
afterAll(() => t.closeAll());

describe("AccountDeleted consumer", () => {
  it("ends links + cancels/purges invites + emits CareLinkEnded; redelivery no-op", async () => {
    await t.servicePg.query(
      `INSERT INTO care_links (patient_id, caregiver_id, caregiver_email, status) VALUES ($1,$2,'a@x.com','active'),($3,$1,'b@x.com','active')`,
      [PATIENT_ID, CAREGIVER_ID, "33333333-3333-4333-8333-333333333333"],
    );
    await t.servicePg.query(
      `INSERT INTO care_link_invites (patient_id, caregiver_email, token_hash, status, expires_at) VALUES ($1,'c@x.com','h1','pending', now() + interval '7 days')`,
      [PATIENT_ID],
    );
    const { handleAccountDeleted } = await import(
      "@application/AccountDeletion/handleAccountDeleted.js"
    );
    const deps = { db: t.db, directory: t.directory, metrics: t.metrics };
    await handleAccountDeleted(deps, { userId: PATIENT_ID });

    const count = async (table: string) =>
      (
        await t.servicePg.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM ${table}`,
        )
      ).rows[0].c;
    expect(await count("care_links")).toBe(0);
    expect(await count("care_link_invites")).toBe(0);

    const endedEvents = async () =>
      (
        await t.servicePg.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM outbox WHERE event_type='CareLinkEnded'`,
        )
      ).rows[0].c;
    expect(await endedEvents()).toBe(2);

    // redelivery → zero new events (terminal guards)
    await handleAccountDeleted(deps, { userId: PATIENT_ID });
    expect(await endedEvents()).toBe(2);
  });
});
