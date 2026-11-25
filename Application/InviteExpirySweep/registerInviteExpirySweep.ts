import { schedule, type ScheduledTask } from "node-cron";
import type { Db } from "@infrastructure/Persistence/db.js";
import { inviteExpirySweepTick } from "./inviteExpirySweep.js";
import type { Metrics } from "@core/metrics.js";

export function registerInviteExpirySweep(deps: {
  db: Db;
  metrics: Metrics;
  reportError?: (err: unknown) => void;
}): { task: ScheduledTask; runOnce: () => Promise<{ expired: number }> } {
  const runOnce = async (): Promise<{ expired: number }> => {
    try {
      const result = await inviteExpirySweepTick({ db: deps.db, metrics: deps.metrics });
      deps.metrics.incr("medo_care_job_runs_total", {
        job: "invite-expiry-sweep",
        result: "success",
      });
      return result;
    } catch (err) {
      deps.metrics.incr("medo_care_job_runs_total", {
        job: "invite-expiry-sweep",
        result: "fail",
      });
      throw err;
    }
  };
  const task = schedule(
    "7 * * * *",
    () => {
      void runOnce().catch((err) => deps.reportError?.(err));
    },
    { timezone: "UTC" },
  );
  return { task, runOnce };
}
