// The re-test after a review decision, at the action layer.
//
// A decision changes what the stand-in may count: a Second-hand claim closes a blocking check only
// once the approver has approved it (countsFully in lacuna/core/standin.ts), a rejected claim no
// longer carries an earlier result, an edit changes the text. So approve, reject and edit all
// re-test, narrowed to the responsibilities the claim can touch (RunTestOptions.only), inside the
// action's deadline and under the same "retest" lease as the Re-run test button.
import { db } from "@/lib/db/client";
import { listResponsibilities } from "@/lib/db/queries";
import { getWorkspacePack } from "@/lib/pack";
import { runTest } from "@/lib/lacuna";
import { runWithModelContext } from "@/lib/model/client";
import { ACTION_LEASE_MS, actionContext, exclusive } from "./guard";
import { REPEAT_WAIT_MS } from "./once";

export const RETEST_KEY = "retest";

/** What a decision says when it is saved but the re-test after it did not run. */
export const SAVED_NOT_RETESTED = "Saved. The re-test did not run; press Re-run test.";

/** The responsibilities a claim can change a check of: those that share its entity. */
export async function responsibilitiesOfClaim(ws: string, claimId: string): Promise<string[] | null> {
  const [row] = await db()`SELECT entity FROM claims WHERE workspace_id = ${ws} AND id = ${claimId}`;
  if (!row) return null;
  const entity = String(row.entity);
  return (await listResponsibilities(ws)).filter((r) => r.entities.includes(entity)).map((r) => r.id);
}

export interface RetestHooks {
  /** For tests: replaces the stand-in run of one role. */
  run?: typeof runTest;
}

/**
 * Re-test every tested role for the responsibilities `claimId` touches. Returns true when the
 * scores on screen are current afterwards (the re-test ran, or the claim touches no
 * responsibility), false when it did not run (another re-test held the lease for too long, or
 * it failed). Never throws: the decision it follows is already saved.
 */
export async function retestAfterReview(ws: string, claimId: string, trigger: string, hooks: RetestHooks = {}): Promise<boolean> {
  try {
    const only = await responsibilitiesOfClaim(ws, claimId);
    if (only === null) return false;
    return await retestResponsibilities(ws, only, trigger, hooks);
  } catch (err) {
    console.error(`[retest ${ws}] re-test after ${trigger} failed`, err);
    return false;
  }
}

/**
 * Re-test every tested role once for these responsibilities (a group approval re-tests once, not
 * once per claim). Same lease and deadline as retestAfterReview; true when nothing needed a
 * re-test or it ran. Never throws.
 */
export async function retestResponsibilities(ws: string, only: readonly string[], trigger: string, hooks: RetestHooks = {}): Promise<boolean> {
  try {
    if (only.length === 0) return true;
    const pack = await getWorkspacePack(ws);
    const run = hooks.run ?? runTest;
    return await exclusive(ws, RETEST_KEY, () => runWithModelContext(actionContext(ws), async () => {
      await Promise.all(pack.testRoles.map((role) => run(ws, role, { trigger, only: [...only] })));
      return true;
    }), false, ACTION_LEASE_MS, REPEAT_WAIT_MS);
  } catch (err) {
    console.error(`[retest ${ws}] re-test after ${trigger} failed`, err);
    return false;
  }
}
