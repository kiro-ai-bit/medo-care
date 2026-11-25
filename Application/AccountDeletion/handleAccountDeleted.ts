import type { Db } from "@infrastructure/Persistence/db.js";
import {
  createInvitesRepo,
  createLinksRepo,
} from "@infrastructure/Persistence/repositories.js";
import { appendOutbox } from "@infrastructure/Persistence/outbox.js";
import type { Metrics } from "@core/metrics.js";
import type { DirectoryCache } from "@infrastructure/IdentityClient/directory.js";

// FR-CAR-026/027 — HD-CARE-04/LD-CARE-08: single tx per AccountDeleted.
// Order: outbox CareLinkEnded per active link → cancel pending invites →
// purge all link+invite rows involving user → commit.
export async function handleAccountDeleted(
  deps: { db: Db; directory: DirectoryCache; metrics?: Metrics },
  event: { userId: string },
): Promise<void> {
  const userId = event.userId;
  await deps.db.transaction(async (tx) => {
    const linksTx = createLinksRepo(tx as unknown as Db);
    const invitesTx = createInvitesRepo(tx as unknown as Db);
    const activeLinks = await linksTx.findInvolvingUserActive(userId);
    for (const link of activeLinks) {
      await appendOutbox(tx, {
        type: "CareLinkEnded",
        payload: {
          linkId: link.id,
          patientId: link.patientId,
          caregiverId: link.caregiverId,
          endedBy: userId,
        },
      });
    }
    await invitesTx.cancelPendingForPatient(userId);
    await linksTx.deleteInvolvingUser(userId);
    await invitesTx.deleteByPatientId(userId);
  });
  deps.directory.invalidate(userId);
  deps.metrics?.incr("medo_care_accountdeleted_processed_total");
}
