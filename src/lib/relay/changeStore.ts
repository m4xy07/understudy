// The stored "what changed" record of a snapshot (living handover). Database glue around the
// pure core in ./core/changes. approveSnapshot() prepares the record before its transaction and
// writes it inside, so every snapshot from now on has one, whatever caused it.
import type { TransactionSql } from "postgres";
import { db } from "@/lib/db/client";
import { toTestRun } from "@/lib/db/mappers";
import { getLatestTestRun, listResponsibilities } from "@/lib/db/queries";
import { checksByResp } from "@/lib/lacuna/core/checks";
import { toLacunaPack } from "@/lib/lacuna/adapt";
import type { ResolvedPack } from "@/lib/pack";
import type { RoleKey, TestRun } from "@/lib/types";
import { buildChangeRecord, type ChangeCause, type SnapshotChangeRecord } from "./core/changes";
import type { SnapshotPayload } from "./core/snapshot";
import { parsePayload } from "./handover";

export interface PreparedChange {
  fromSnapshotId: string | null;
  testRunId: string | null;
  record: SnapshotChangeRecord;
}

/** The successor run a snapshot was built on: the stored id, else the newest run before its approval. */
async function runOfSnapshot(ws: string, snapshotId: string, approvedAt: unknown, successor: RoleKey): Promise<TestRun | null> {
  const sql = db();
  const [link] = await sql`SELECT test_run_id FROM snapshot_changes WHERE workspace_id = ${ws} AND snapshot_id = ${snapshotId}`;
  if (link?.test_run_id) {
    const [row] = await sql`SELECT * FROM test_runs WHERE workspace_id = ${ws} AND id = ${String(link.test_run_id)}`;
    if (row) return toTestRun(row);
  }
  const [row] = await sql`
    SELECT * FROM test_runs WHERE workspace_id = ${ws} AND role = ${successor} AND created_at <= ${approvedAt as Date}
    ORDER BY created_at DESC LIMIT 1`;
  return row ? toTestRun(row) : null;
}

/**
 * Work out what the snapshot about to be written changes against the latest stored one.
 * The cause is a finding when an approved finding that no snapshot carries yet is in the new
 * payload; "first" for version 1; otherwise the approver released a new version by hand.
 */
export async function prepareSnapshotChange(ws: string, pack: ResolvedPack, payload: SnapshotPayload): Promise<PreparedChange> {
  const sql = db();
  const successor = pack.successorRole as RoleKey;
  const [prevRow] = await sql`SELECT id, approved_at, payload FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC LIMIT 1`;
  const prev = prevRow ? parsePayload(prevRow.payload) : null;
  const [after, before, resps] = await Promise.all([
    getLatestTestRun(ws, successor),
    prevRow ? runOfSnapshot(ws, String(prevRow.id), prevRow.approved_at, successor) : Promise.resolve(null),
    listResponsibilities(ws),
  ]);
  const checks = checksByResp(resps, toLacunaPack(pack));
  const claimIds = payload.claims.map((c) => c.id);
  const waiting = claimIds.length
    ? await sql`
        SELECT id FROM findings WHERE workspace_id = ${ws} AND status = 'approved' AND snapshot_id IS NULL
          AND claim_id = ANY(${claimIds}::text[]) ORDER BY id`
    : [];
  const findingIds = waiting.map((r) => String(r.id));
  const cause: ChangeCause = !prevRow
    ? { type: "first", findingIds }
    : findingIds.length ? { type: "finding", findingIds } : { type: "manual", findingIds: [] };
  const record = buildChangeRecord({
    prev,
    next: payload,
    before: prevRow && before ? before : null,
    after: after ?? { scores: payload.scores, results: [] },
    checks,
    cause,
  });
  return { fromSnapshotId: prevRow ? String(prevRow.id) : null, testRunId: after?.id ?? null, record };
}

/** Write the record and tie the findings it carries to the snapshot. Runs inside approveSnapshot's transaction. */
export async function insertSnapshotChange(tx: TransactionSql, ws: string, snapshotId: string, change: PreparedChange): Promise<void> {
  const r = change.record;
  await tx`
    INSERT INTO snapshot_changes (workspace_id, snapshot_id, from_snapshot_id, test_run_id, diff, gaps_closed, gaps_opened,
      claim_changes, delta_text, lines, cause)
    VALUES (${ws}, ${snapshotId}, ${change.fromSnapshotId}, ${change.testRunId}, ${JSON.stringify(r.diff)}::jsonb,
      ${JSON.stringify(r.gapsClosed)}::jsonb, ${JSON.stringify(r.gapsOpened)}::jsonb, ${JSON.stringify(r.claimChanges)}::jsonb,
      ${r.deltaText}, ${JSON.stringify(r.lines)}::jsonb, ${JSON.stringify(r.cause)}::jsonb)`;
  if (r.cause.findingIds.length) {
    await tx`
      UPDATE findings SET snapshot_id = ${snapshotId}, score_delta = ${r.deltaText}
      WHERE workspace_id = ${ws} AND id = ANY(${r.cause.findingIds}::text[]) AND snapshot_id IS NULL`;
  }
}
