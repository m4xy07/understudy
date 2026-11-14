// Faster feedback after an answer (Round 2 fix f), at the action layer.
//
// Saving an answer used to wait for a live stand-in call per tested role (6 to 16 s). Now:
//   1. fastFirst(fn) runs the save with live model calls held back. Cached stand-in answers still
//      replay; a responsibility the answer changed is read by the rule-based stand-in, which takes
//      milliseconds. The model can only ever lower coverage, so this first result is the upper
//      reading and is labelled as such.
//   2. scheduleRejudge(ws) re-runs the test with the live model in the background (after()). The
//      run-status poll reports it, and the page refreshes when it ends.
// It works on whatever runTest does: a full run today, or a run narrowed to one responsibility.
// Safe because: one re-check at a time per workspace (a lease); an answer saved while a re-check
// is running bumps a generation counter, and the worker goes round again, so the last stored run
// always started after the last answer. Every writer of evidence (an answer, a neighbour's answer,
// a review decision, a finding, a plan entry) calls evidenceChanged(ws), which bumps the same
// counter; and the re-check refuses to store a run whose inputs changed while it was judging
// (runTest refuseStale), so it can never put an older reading on top of newer evidence.
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { toTestRun } from "@/lib/db/mappers";
import { listResponsibilities } from "@/lib/db/queries";
import { getWorkspacePack } from "@/lib/pack";
import { runTest, StaleTestError, testInputFingerprint, toLacunaPack } from "@/lib/lacuna";
import { audit } from "@/lib/db/queries";
import { checksByResp } from "@/lib/lacuna/core/checks";
import { scoreDelta } from "@/lib/lacuna/core/scores";
import { modelDisabled, runWithModelContext } from "@/lib/model/client";
import { ACTION_LEASE_MS, actionContext } from "./guard";

export const REJUDGE_KEY = "rejudge";
/** At least as long as the function that runs the re-check may live (it renews it every round). */
const REJUDGE_TTL_S = ACTION_LEASE_MS / 1000;
export const MAX_ROUNDS = 3;

export type RejudgeOutcome = "settled" | "not_settled" | "lost" | "failed";

/**
 * Tell a running re-check that the evidence changed (a decision, an answer, a plan entry): it goes
 * round again. A no-op when no re-check is running. Never throws.
 */
export async function evidenceChanged(ws: string): Promise<void> {
  try {
    await db()`
      UPDATE action_leases SET generation = generation + 1
      WHERE workspace_id = ${ws} AND key = ${REJUDGE_KEY} AND expires_at > now()`;
  } catch (err) {
    console.error(`[rejudge ${ws}] could not note the change`, err);
  }
}

/** True when a live stand-in model could change a rule-based reading (so a re-check is worth it). */
export function liveStandin(): boolean {
  const mode = (process.env.LACUNA_MODEL ?? "").trim();
  return !modelDisabled() && mode !== "off" && mode !== "cache";
}

/** Run `fn` with live model calls held back: cached answers replay, the rest is rule-based. */
export function fastFirst<T>(fn: () => Promise<T>): Promise<T> {
  return runWithModelContext({ deadline: 0 }, fn);
}

/**
 * Ask for a background model re-check. Returns the work to run inside after(), or null when
 * another re-check is already running (it will pick this request up) or none is needed.
 * `only`: the responsibilities the answer changed. The first round judges just those (the rest is
 * copied from the latest run); if anything else changed meanwhile, the next round judges everything.
 */
export async function scheduleRejudge(
  ws: string, only?: string[], opts: { force?: boolean } = {},
): Promise<(() => Promise<RejudgeOutcome>) | null> {
  if (!opts.force && !liveStandin()) return null;
  const holder = randomUUID();
  let mine = false;
  let startGeneration = 0;
  try {
    const [row] = await db()`
      INSERT INTO action_leases (workspace_id, key, holder, generation, expires_at)
      VALUES (${ws}, ${REJUDGE_KEY}, ${holder}, 1, now() + make_interval(secs => ${REJUDGE_TTL_S}))
      ON CONFLICT (workspace_id, key) DO UPDATE SET
        generation = action_leases.generation + 1,
        holder = CASE WHEN action_leases.expires_at < now() THEN EXCLUDED.holder ELSE action_leases.holder END,
        expires_at = EXCLUDED.expires_at
      RETURNING holder, generation`;
    mine = String(row?.holder) === holder;
    startGeneration = Number(row?.generation ?? 0);
  } catch (err) {
    console.error(`[rejudge ${ws}] could not schedule`, err);
    return null;
  }
  if (!mine) return null;
  return () => rejudge(ws, holder, only && only.length > 0 ? { only, generation: startGeneration } : null);
}

async function rejudge(ws: string, holder: string, narrow: { only: string[]; generation: number } | null): Promise<RejudgeOutcome> {
  const sql = db();
  let outcome: RejudgeOutcome = "not_settled";
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const [lease] = await sql`
        UPDATE action_leases SET expires_at = now() + make_interval(secs => ${REJUDGE_TTL_S})
        WHERE workspace_id = ${ws} AND key = ${REJUDGE_KEY} AND holder = ${holder} RETURNING generation`;
      if (!lease) return "lost"; // the lease expired and someone else took over
      const generation = Number(lease.generation);

      const pack = await getWorkspacePack(ws);
      // Narrowed to the changed responsibility only while nothing else has changed since it was asked for.
      const only = narrow && generation === narrow.generation ? narrow.only : undefined;
      // One fingerprint for every role of this round, taken before any of them reads.
      const inputs = await testInputFingerprint(ws);
      let runs;
      try {
        runs = await runWithModelContext(actionContext(ws), () =>
          Promise.all(pack.testRoles.map((role) => runTest(ws, role, {
            trigger: "model re-check", refuseStale: inputs, ...(only ? { only, rejudge: true } : {}),
          }))));
      } catch (err) {
        if (!(err instanceof StaleTestError)) throw err;
        // The evidence changed while the model was judging: nothing was stored. Go round again,
        // whether or not the writer bumped the counter.
        await sql`UPDATE action_leases SET generation = generation + 1
          WHERE workspace_id = ${ws} AND key = ${REJUDGE_KEY} AND holder = ${holder}`;
        continue;
      }
      const after = runs[0];

      // The sentence under the newest answer: from the run before that answer to the model's run.
      const [q] = await sql`
        SELECT id, answered_at FROM gap_questions
        WHERE workspace_id = ${ws} AND answered_claim_id IS NOT NULL AND answered_at IS NOT NULL
        ORDER BY answered_at DESC LIMIT 1`;
      if (q && after) {
        const [b] = await sql`
          SELECT * FROM test_runs WHERE workspace_id = ${ws} AND role = ${pack.successorRole} AND created_at < ${q.answered_at}
          ORDER BY created_at DESC LIMIT 1`;
        if (b) {
          const checks = checksByResp(await listResponsibilities(ws), toLacunaPack(pack));
          const delta = scoreDelta(toTestRun(b), after, checks);
          await sql`UPDATE gap_questions SET score_delta = ${delta} WHERE workspace_id = ${ws} AND id = ${q.id}`;
        }
      }

      // Done unless another answer arrived while this round ran.
      const gone = await sql`
        DELETE FROM action_leases
        WHERE workspace_id = ${ws} AND key = ${REJUDGE_KEY} AND holder = ${holder} AND generation = ${generation}
        RETURNING key`;
      if (gone.length) return "settled";
    }
  } catch (err) {
    outcome = "failed";
    console.error(`[rejudge ${ws}] failed; the rule-based reading stays`, err);
  }
  // Not settled: evidence kept changing for MAX_ROUNDS rounds (or the re-check failed). The lease
  // is given up so the next answer can start a re-check, and the fact is recorded, not dropped:
  // the stored reading is the rule-based one (the upper reading) until a re-test runs.
  await sql`DELETE FROM action_leases WHERE workspace_id = ${ws} AND key = ${REJUDGE_KEY} AND holder = ${holder}`.catch(() => {});
  await audit(ws, "system", "rejudge_not_settled", { outcome, rounds: MAX_ROUNDS }).catch(() => {});
  return outcome;
}
