import type { Db } from "@infrastructure/Persistence/db.js";
import { createInvitesRepo } from "@infrastructure/Persistence/repositories.js";
import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import type { Metrics } from "@core/metrics.js";

// FR-CAR-019 — hourly expiry tick; per-invite tx, status guard = exactly once.
export async function inviteExpirySweepTick(
  deps: { db: Db; metrics?: Metrics; now?: () => Date },
): Promise<{ expired: number }> {
  const t = deps.now?.() ?? new Date();
  const invites = createInvitesRepo(deps.db);
  const rows = await invites.findPendingExpired(t);
  let expired = 0;
  for (const inv of rows) {
    const did = await deps.db.transaction(async (tx) => {
      const row = await createInvitesRepo(tx as unknown as Db).expireIfDue(
        inv.id,
        t,
      );
      if (row) {
        await appendOutbox(tx, {
          type: "CareLinkInviteExpired",
          payload: { inviteId: inv.id, patientId: inv.patientId },
        });
        return true;
      }
      return false;
    });
    if (did) expired += 1;
  }
  deps.metrics?.incr("medo_care_invites_total", { action: "expired" }, expired);
  return { expired };
}
