import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { hashInviteToken } from "@core/Tokens/inviteToken.js";
import {
  CAREGIVER_ID,
  CAREGIVER2_ID,
  PATIENT2_ID,
  PATIENT_ID,
  createTestApp,
  mintPeerServiceToken,
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

async function createInvite(email = "caregiver@example.com") {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/care/links/invites",
    headers: auth(await patientToken()),
    payload: { caregiverEmail: email },
  });
  return res;
}

describe("invite lifecycle", () => {
  it("create invite → 201 pending + outbox event", async () => {
    const res = await createInvite();
    expect(res.statusCode).toBe(201);
    const body = j(res);
    expect(body.status).toBe("pending");
    expect(body.caregiverEmail).toBe("caregiver@example.com");
    const ev = await t.servicePg.query<{ payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM outbox WHERE event_type='CareLinkInviteCreated'`,
    );
    expect(ev.rows.length).toBe(1);
    const payload = ev.rows[0].payload;
    expect(payload.inviteId).toBe(body.inviteId);
    expect(String(payload.inviteLink)).toContain("https://app.test/invite/");
  });

  it("dup pending invite same patient+email → 409", async () => {
    await createInvite("dup@example.com");
    const res = await createInvite("dup@example.com");
    expect(res.statusCode).toBe(409);
  });

  it("non-Patient role → 403", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/care/links/invites",
      headers: auth(await caregiverToken()),
      payload: { caregiverEmail: "x@example.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("preview returns displayName + expiresAt; dead token uniform 404", async () => {
    const created = j(await createInvite("preview@example.com"));
    const link = (
      await t.servicePg.query<{ l: string }>(
        `SELECT payload->>'inviteLink' AS l FROM outbox WHERE event_type='CareLinkInviteCreated' AND payload->>'inviteId'=$1`,
        [created.inviteId],
      )
    ).rows[0].l as string;
    const token = link.split("/invite/")[1];
    const ok = await t.app.inject({ method: "GET", url: `/v1/care/invites/${token}` });
    expect(ok.statusCode).toBe(200);
    expect(j(ok).patientDisplayName).toBe("Patient One");
    const dead = await t.app.inject({
      method: "GET",
      url: "/v1/care/invites/not-a-real-token",
    });
    expect(dead.statusCode).toBe(404);
  });

  it("accept wrong email → 403; correct caregiver → 201 + link + event", async () => {
    // patient2 + caregiver@example.com (patient1's pending invite untouched)
    const p2 = await mintUserToken(t.keys, { sub: PATIENT2_ID, role: "Patient" });
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/care/links/invites",
      headers: auth(p2),
      payload: { caregiverEmail: "caregiver@example.com" },
    });
    const created = j(res);
    const link = (
      await t.servicePg.query<{ l: string }>(
        `SELECT payload->>'inviteLink' AS l FROM outbox WHERE event_type='CareLinkInviteCreated' AND payload->>'inviteId'=$1 ORDER BY id DESC LIMIT 1`,
        [created.inviteId],
      )
    ).rows[0].l as string;
    const token = link.split("/invite/")[1];
    // caregiver2 email doesn't match invite
    const wrong = await t.app.inject({
      method: "POST",
      url: `/v1/care/invites/${token}/accept`,
      headers: auth(await caregiverToken(CAREGIVER2_ID)),
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await t.app.inject({
      method: "POST",
      url: `/v1/care/invites/${token}/accept`,
      headers: auth(await caregiverToken()),
    });
    expect(ok.statusCode).toBe(201);
    expect(j(ok).patientId).toBe(PATIENT2_ID);
    expect(j(ok).caregiverId).toBe(CAREGIVER_ID);
    // replay → 404 (single-use)
    const replay = await t.app.inject({
      method: "POST",
      url: `/v1/care/invites/${token}/accept`,
      headers: auth(await caregiverToken()),
    });
    expect(replay.statusCode).toBe(404);
    const ev = await t.servicePg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox WHERE event_type='CareLinkCreated'`,
    );
    expect(ev.rows[0].c).toBe(1);
  });

  it("decline → 200 declined + CareLinkInviteDeclined event", async () => {
    // invite caregiver2's email; caregiver2 declines (email match)
    const created = j(await createInvite("caregiver2@example.com"));
    const link = (
      await t.servicePg.query<{ l: string }>(
        `SELECT payload->>'inviteLink' AS l FROM outbox WHERE event_type='CareLinkInviteCreated' AND payload->>'inviteId'=$1 ORDER BY id DESC LIMIT 1`,
        [created.inviteId],
      )
    ).rows[0].l as string;
    const token = link.split("/invite/")[1];
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/care/invites/${token}/decline`,
      headers: auth(await caregiverToken(CAREGIVER2_ID)),
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).status).toBe("declined");
    // replay → 404 (single-use)
    const replay = await t.app.inject({
      method: "POST",
      url: `/v1/care/invites/${token}/decline`,
      headers: auth(await caregiverToken(CAREGIVER2_ID)),
    });
    expect(replay.statusCode).toBe(404);
  });

  it("resend cap: 3 ok, 4th → 409; same inviteLink republished", async () => {
    const created = j(await createInvite("resend@example.com"));
    const id = created.inviteId;
    for (let i = 0; i < 3; i++) {
      const res = await t.app.inject({
        method: "POST",
        url: `/v1/care/invites/${id}/resend`,
        headers: auth(await patientToken()),
      });
      expect(res.statusCode).toBe(200);
    }
    const fourth = await t.app.inject({
      method: "POST",
      url: `/v1/care/invites/${id}/resend`,
      headers: auth(await patientToken()),
    });
    expect(fourth.statusCode).toBe(409);
    const evs = await t.servicePg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox WHERE event_type='CareLinkInviteCreated' AND payload->>'inviteId'=$1`,
      [id],
    );
    expect(evs.rows[0].c).toBe(4); // create + 3 resends
  });

  it("expired token → uniform 404 + CareLinkInviteExpired exactly once", async () => {
    const raw = "expired-raw-token";
    await t.servicePg.query(
      `INSERT INTO care_link_invites (patient_id, caregiver_email, token_hash, status, expires_at)
       VALUES ($1,'exp@example.com',$2,'pending', now() - interval '1 hour')`,
      [PATIENT_ID, hashInviteToken(raw)],
    );
    for (let i = 0; i < 2; i++) {
      const res = await t.app.inject({
        method: "GET",
        url: `/v1/care/invites/${raw}`,
      });
      expect(res.statusCode).toBe(404);
    }
    const ev = await t.servicePg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox WHERE event_type='CareLinkInviteExpired'`,
    );
    expect(ev.rows[0].c).toBe(1);
    const row = await t.servicePg.query<{ status: string }>(
      `SELECT status FROM care_link_invites WHERE token_hash=$1`,
      [hashInviteToken(raw)],
    );
    expect(row.rows[0].status).toBe("expired");
  });

  it("cancel → 200 cancelled, silent (no event); repeat → 409", async () => {
    const created = j(await createInvite("cancel@example.com"));
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/care/invites/${created.inviteId}/cancel`,
      headers: auth(await patientToken()),
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).status).toBe("cancelled");
    const again = await t.app.inject({
      method: "POST",
      url: `/v1/care/invites/${created.inviteId}/cancel`,
      headers: auth(await patientToken()),
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("links + check-link", () => {
  it("end link either party → CareLinkEnded; check-link flips inactive", async () => {
    // seed an active link directly
    await t.servicePg.query(
      `INSERT INTO care_links (patient_id, caregiver_id, caregiver_email, status) VALUES ($1,$2,'caregiver@example.com','active')`,
      [PATIENT_ID, CAREGIVER_ID],
    );
    const svc = await mintPeerServiceToken(t.keys);
    const before = await t.app.inject({
      method: "GET",
      url: `/v1/care/check-link?patientId=${PATIENT_ID}&caregiverId=${CAREGIVER_ID}`,
      headers: auth(svc),
    });
    expect(j(before)).toEqual({ active: true });

    const links = await t.app.inject({
      method: "GET",
      url: "/v1/care/links",
      headers: auth(await patientToken()),
    });
    const linkId = j(links).links[0].linkId;
    const end = await t.app.inject({
      method: "POST",
      url: `/v1/care/links/${linkId}/end`,
      headers: auth(await caregiverToken()),
    });
    expect(end.statusCode).toBe(200);
    const after = await t.app.inject({
      method: "GET",
      url: `/v1/care/check-link?patientId=${PATIENT_ID}&caregiverId=${CAREGIVER_ID}`,
      headers: auth(svc),
    });
    expect(j(after)).toEqual({ active: false });
    const inv = await t.app.inject({
      method: "GET",
      url: `/v1/care/patients/${PATIENT_ID}/links`,
      headers: auth(svc),
    });
    expect(j(inv).links).toEqual([]);
  });

  it("check-link rejects user JWT and wrong-aud service token", async () => {
    const userTok = await patientToken();
    const r1 = await t.app.inject({
      method: "GET",
      url: `/v1/care/check-link?patientId=${PATIENT_ID}&caregiverId=${CAREGIVER_ID}`,
      headers: auth(userTok),
    });
    expect(r1.statusCode).toBe(401);
    const wrongAud = await mintPeerServiceToken(t.keys, { aud: "medo-identity" });
    const r2 = await t.app.inject({
      method: "GET",
      url: `/v1/care/check-link?patientId=${PATIENT_ID}&caregiverId=${CAREGIVER_ID}`,
      headers: auth(wrongAud),
    });
    expect(r2.statusCode).toBe(403);
  });
});
