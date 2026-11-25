import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  CAREGIVER_ID,
  PATIENT2_ID,
  PATIENT_ID,
  createTestApp,
  mintUserToken,
  seedDirectory,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ directory: seedDirectory() });
});
afterAll(() => t.closeAll());

async function patientToken(sub = PATIENT_ID) {
  return mintUserToken(t.keys, { sub, role: "Patient" });
}
async function caregiverToken(sub = CAREGIVER_ID) {
  return mintUserToken(t.keys, { sub, role: "Caregiver" });
}
function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: { json(): unknown }) => r.json() as Record<string, any>;

async function createInvite(email: string, patientSub = PATIENT_ID) {
  return t.app.inject({
    method: "POST",
    url: "/v1/care/links/invites",
    headers: auth(await patientToken(patientSub)),
    payload: { caregiverEmail: email },
  });
}

describe("GET /v1/care/invites", () => {
  it("patient sees sent invites; caregiver sees received invites", async () => {
    const created = j(await createInvite("caregiver@example.com"));
    expect(created.status).toBe("pending");

    const sent = await t.app.inject({
      method: "GET",
      url: "/v1/care/invites",
      headers: auth(await patientToken()),
    });
    expect(sent.statusCode).toBe(200);
    const sentItem = j(sent).invites.find(
      (i: { inviteId: string }) => i.inviteId === created.inviteId,
    );
    expect(sentItem.direction).toBe("sent");
    expect(sentItem.counterpartyEmail).toBe("caregiver@example.com");

    const received = await t.app.inject({
      method: "GET",
      url: "/v1/care/invites",
      headers: auth(await caregiverToken()),
    });
    expect(received.statusCode).toBe(200);
    const recvItem = j(received).invites.find(
      (i: { inviteId: string }) => i.inviteId === created.inviteId,
    );
    expect(recvItem.direction).toBe("received");
    expect(recvItem.counterpartyDisplayName).toBe("Patient One");
    expect(recvItem.counterpartyEmail).toBeUndefined();

    // email-match: caregiver2 (different email) must NOT see it
    const other = await t.app.inject({
      method: "GET",
      url: "/v1/care/invites",
      headers: auth(
        await caregiverToken("33333333-3333-4333-8333-333333333333"),
      ),
    });
    expect(
      j(other).invites.some(
        (i: { inviteId: string }) => i.inviteId === created.inviteId,
      ),
    ).toBe(false);
  });

  it("non-pending invites are excluded from both lists", async () => {
    // PATIENT2_ID: PATIENT_ID already holds a pending invite to this email
    const created = j(await createInvite("caregiver@example.com", PATIENT2_ID));
    await t.app.inject({
      method: "POST",
      url: `/v1/care/invites/${created.inviteId}/cancel`,
      headers: auth(await patientToken(PATIENT2_ID)),
    });
    const sent = await t.app.inject({
      method: "GET",
      url: "/v1/care/invites",
      headers: auth(await patientToken(PATIENT2_ID)),
    });
    expect(
      j(sent).invites.some(
        (i: { inviteId: string }) => i.inviteId === created.inviteId,
      ),
    ).toBe(false);
    const received = await t.app.inject({
      method: "GET",
      url: "/v1/care/invites",
      headers: auth(await caregiverToken()),
    });
    expect(
      j(received).invites.some(
        (i: { inviteId: string }) => i.inviteId === created.inviteId,
      ),
    ).toBe(false);
  });
});

describe("end link authz", () => {
  async function seedActiveLink() {
    const res = await t.servicePg.query<{ id: string }>(
      `INSERT INTO care_links (patient_id, caregiver_id, caregiver_email, status)
       VALUES ($1,$2,'caregiver@example.com','active') RETURNING id`,
      [PATIENT2_ID, CAREGIVER_ID],
    );
    return res.rows[0].id;
  }

  it("patient can end own link; endedBy marker persisted", async () => {
    const linkId = await seedActiveLink();
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/care/links/${linkId}/end`,
      headers: auth(await patientToken(PATIENT2_ID)),
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).status).toBe("ended");
    const row = await t.servicePg.query<{
      status: string;
      ended_by: string;
    }>(`SELECT status, ended_by FROM care_links WHERE id=$1`, [linkId]);
    expect(row.rows[0].status).toBe("ended");
    expect(row.rows[0].ended_by).toBe(PATIENT2_ID);
    const ev = await t.servicePg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox WHERE event_type='CareLinkEnded' AND payload->>'linkId'=$1`,
      [linkId],
    );
    expect(ev.rows[0].c).toBe(1);
  });

  it("GET /v1/care/links returns as-caregiver direction for caregiver", async () => {
    await t.servicePg.query(
      `INSERT INTO care_links (patient_id, caregiver_id, caregiver_email, status) VALUES ($1,$2,'caregiver@example.com','active')`,
      [PATIENT_ID, CAREGIVER_ID],
    );
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/care/links",
      headers: auth(await caregiverToken()),
    });
    expect(res.statusCode).toBe(200);
    const mine = j(res).links.find(
      (l: { counterpart: { userId: string } }) =>
        l.counterpart.userId === PATIENT_ID,
    );
    expect(mine.direction).toBe("as-caregiver");
    expect(mine.counterpart.displayName).toBe("Patient One");
  });

  it("non-party → 403; repeat end → 409", async () => {
    const linkId = await seedActiveLink();
    // PATIENT_ID is not a party to the PATIENT2↔CAREGIVER link
    const forbidden = await t.app.inject({
      method: "POST",
      url: `/v1/care/links/${linkId}/end`,
      headers: auth(await patientToken()),
    });
    expect(forbidden.statusCode).toBe(403);
    const first = await t.app.inject({
      method: "POST",
      url: `/v1/care/links/${linkId}/end`,
      headers: auth(await caregiverToken()),
    });
    expect(first.statusCode).toBe(200);
    const second = await t.app.inject({
      method: "POST",
      url: `/v1/care/links/${linkId}/end`,
      headers: auth(await caregiverToken()),
    });
    expect(second.statusCode).toBe(409);
  });
});

describe("invite-expiry-sweep", () => {
  it("expires stale pending invites once + publishes CareLinkInviteExpired; fresh invites untouched", async () => {
    await t.servicePg.query(
      `INSERT INTO care_link_invites (patient_id, caregiver_email, token_hash, status, expires_at)
       VALUES ($1,'old@example.com','h-old','pending', now() - interval '1 hour'),
              ($2,'fresh@example.com','h-fresh','pending', now() + interval '7 days')`,
      [PATIENT_ID, PATIENT2_ID],
    );
    const first = await t.inviteExpiryRunOnce();
    expect(first.expired).toBe(1); // only the seeded stale invite is due

    const rows = await t.servicePg.query<{
      token_hash: string;
      status: string;
    }>(
      `SELECT token_hash, status FROM care_link_invites WHERE token_hash IN ('h-old','h-fresh')`,
    );
    const byHash = new Map(rows.rows.map((r) => [r.token_hash, r.status]));
    expect(byHash.get("h-old")).toBe("expired");
    expect(byHash.get("h-fresh")).toBe("pending");

    const ev = await t.servicePg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox WHERE event_type='CareLinkInviteExpired' AND payload->>'inviteId' IN (SELECT id::text FROM care_link_invites WHERE token_hash='h-old')`,
    );
    expect(ev.rows[0].c).toBe(1);

    // second tick → idempotent: h-old already expired, no new event
    const expiredCount = async () =>
      (
        await t.servicePg.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM outbox WHERE event_type='CareLinkInviteExpired'`,
        )
      ).rows[0].c;
    const before = await expiredCount();
    await t.inviteExpiryRunOnce();
    expect(await expiredCount()).toBe(before);
  });
});
