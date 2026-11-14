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
// always started after the last answer.
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { toTestRun } from "@/lib/db/mappers";
import { listResponsibilities } from "@/lib/db/queries";
import { getWorkspacePack } from "@/lib/pack";
import { runTest, toLacunaPack } from "@/lib/lacuna";
import { checksByResp } from "@/lib/lacuna/core/checks";
import { scoreDelta } from "@/lib/lacuna/core/scores";
import { modelDisabled, runWithModelContext } from "@/lib/model/client";
import { spendContext } from "./guard";

export const REJUDGE_KEY = "rejudge";
const REJUDGE_TTL_S = 150;
const MAX_ROUNDS = 3;

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
 */
export async function scheduleRejudge(ws: string): Promise<(() => Promise<void>) | null> {
  if (!liveStandin()) return null;
  const holder = randomUUID();
  let mine = false;
  try {
    const [row] = await db()`
      INSERT INTO action_leases (workspace_id, key, holder, generation, expires_at)
      VALUES (${ws}, ${REJUDGE_KEY}, ${holder}, 1, now() + make_interval(secs => ${REJUDGE_TTL_S}))
      ON CONFLICT (workspace_id, key) DO UPDATE SET
        generation = action_leases.generation + 1,
        holder = CASE WHEN action_leases.expires_at < now() THEN EXCLUDED.holder ELSE action_leases.holder END,
        expires_at = EXCLUDED.expires_at
      RETURNING holder`;
    mine = String(row?.holder) === holder;
  } catch (err) {
    console.error(`[rejudge ${ws}] could not schedule`, err);
    return null;
  }
  if (!mine) return null;
  return () => rejudge(ws, holder);
}

async function rejudge(ws: string, holder: string): Promise<void> {
  const sql = db();
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const [lease] = await sql`
        UPDATE action_leases SET expires_at = now() + make_interval(secs => ${REJUDGE_TTL_S})
        WHERE workspace_id = ${ws} AND key = ${REJUDGE_KEY} AND holder = ${holder} RETURNING generation`;
      if (!lease) return; // the lease expired and someone else took over
      const generation = Number(lease.generation);

      const pack = await getWorkspacePack(ws);
      const runs = await runWithModelContext(spendContext(ws), () =>
        Promise.all(pack.testRoles.map((role) => runTest(ws, role, { trigger: "model re-check" }))));
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
      if (gone.length) return;
    }
  } catch (err) {
    console.error(`[rejudge ${ws}] failed; the rule-based reading stays`, err);
  }
  await sql`DELETE FROM action_leases WHERE workspace_id = ${ws} AND key = ${REJUDGE_KEY} AND holder = ${holder}`.catch(() => {});
}
