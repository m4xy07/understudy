// Read helpers used by pages and modules. Role-scoped reads go through withRole (RLS);
// everything else runs as the app user and is scoped by workspace_id explicitly.
import { db } from "./client";
import { withRole, isUuid } from "./withRole";
import {
  toClaim, toGapQuestion, toPerson, toPlanItem, toResponsibility, toRun, toSegment, toSnapshot,
  toSource, toTestRun, toWorkspace,
  type RunStatus, type SourceRow, type Workspace,
} from "./mappers";
import type {
  Claim, GapQuestion, Person, PlanItem, Responsibility, RoleKey, Segment, Snapshot, TestRun,
} from "@/lib/types";

export async function getWorkspace(ws: string): Promise<Workspace | null> {
  if (!isUuid(ws)) return null;
  const rows = await db()`SELECT * FROM workspaces WHERE id = ${ws}`;
  return rows[0] ? toWorkspace(rows[0]) : null;
}

export async function listSources(ws: string): Promise<SourceRow[]> {
  const rows = await db()`SELECT * FROM sources WHERE workspace_id = ${ws} ORDER BY imported_at, name`;
  return rows.map(toSource);
}

export async function listPeople(ws: string): Promise<Person[]> {
  const rows = await db()`SELECT * FROM people WHERE workspace_id = ${ws} ORDER BY id`;
  return rows.map(toPerson);
}

/** Display names by person id (UI only; names are never used as IDs). */
export async function peopleNames(ws: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of await listPeople(ws)) out[p.id] = p.displayName;
  return out;
}

/**
 * Claims in a workspace. With `role`, the read runs under RLS as that role, so only
 * claims whose role set contains the role exist. Without `role`, an admin read (all claims).
 */
export async function listClaims(ws: string, opts: { role?: RoleKey } = {}): Promise<Claim[]> {
  if (opts.role) {
    const rows = await withRole(ws, opts.role, (tx) =>
      tx`SELECT * FROM claims WHERE workspace_id = ${ws} ORDER BY entity, attribute, valid_from, id`);
    return rows.map(toClaim);
  }
  const rows = await db()`SELECT * FROM claims WHERE workspace_id = ${ws} ORDER BY entity, attribute, valid_from, id`;
  return rows.map(toClaim);
}

/** Admin read of every segment (pipeline steps). */
export async function listSegments(ws: string): Promise<Segment[]> {
  const rows = await db()`
    SELECT DISTINCT ON (id) * FROM segments WHERE workspace_id = ${ws}
    ORDER BY id, version DESC`;
  return rows.map(toSegment);
}

export interface SegmentView {
  segment: Segment;
  sourceName: string;
  authorName: string | null;
}

/**
 * One segment (latest version) as `role` sees it. Returns null when the segment does not
 * exist or RLS hides it from this role (the caller says "not visible to your role").
 */
export async function getSegment(ws: string, segmentId: string, role: RoleKey): Promise<SegmentView | null> {
  const rows = await withRole(ws, role, (tx) =>
    tx`SELECT * FROM segments WHERE workspace_id = ${ws} AND id = ${segmentId} ORDER BY version DESC LIMIT 1`);
  if (!rows[0]) return null;
  const segment = toSegment(rows[0]);
  const [src] = await db()`SELECT name FROM sources WHERE workspace_id = ${ws} AND id = ${segment.sourceId}`;
  let authorName: string | null = null;
  if (segment.authorId) {
    const [p] = await db()`SELECT display_name FROM people WHERE workspace_id = ${ws} AND id = ${segment.authorId}`;
    authorName = p ? String(p.display_name) : null;
  }
  return { segment, sourceName: src ? String(src.name) : segment.sourceId, authorName };
}

/** True when a segment id exists in the workspace at all (admin check, no content). */
export async function segmentExists(ws: string, segmentId: string): Promise<boolean> {
  const rows = await db()`SELECT 1 FROM segments WHERE workspace_id = ${ws} AND id = ${segmentId} LIMIT 1`;
  return rows.length > 0;
}

export async function listResponsibilities(ws: string): Promise<Responsibility[]> {
  const rows = await db()`SELECT * FROM responsibilities WHERE workspace_id = ${ws} ORDER BY key`;
  return rows.map(toResponsibility);
}

export async function getLatestTestRun(ws: string, role: RoleKey): Promise<TestRun | null> {
  const rows = await db()`
    SELECT * FROM test_runs WHERE workspace_id = ${ws} AND role = ${role}
    ORDER BY created_at DESC LIMIT 1`;
  return rows[0] ? toTestRun(rows[0]) : null;
}

/** The latest two runs for a role, newest first (for "B 7 -> 4" style deltas). */
export async function getTestRunHistory(ws: string, role: RoleKey, limit = 2): Promise<TestRun[]> {
  const rows = await db()`
    SELECT * FROM test_runs WHERE workspace_id = ${ws} AND role = ${role}
    ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(toTestRun);
}

export async function listGapQuestions(ws: string): Promise<GapQuestion[]> {
  const rows = await db()`SELECT * FROM gap_questions WHERE workspace_id = ${ws} ORDER BY rank`;
  return rows.map(toGapQuestion);
}

export async function listPlanItems(ws: string): Promise<PlanItem[]> {
  const rows = await db()`SELECT * FROM plan_items WHERE workspace_id = ${ws} ORDER BY responsibility_id, check_key`;
  return rows.map(toPlanItem);
}

export async function listSnapshots(ws: string): Promise<Snapshot[]> {
  const rows = await db()`SELECT * FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC`;
  return rows.map(toSnapshot);
}

/** Latest pipeline run for the workspace, or null when none has started. */
export async function getRunStatus(ws: string): Promise<RunStatus | null> {
  if (!isUuid(ws)) return null;
  const rows = await db()`
    SELECT *, (status = 'paused' OR (status = 'running' AND (lease_until IS NULL OR lease_until < now()))) AS resumable
    FROM runs WHERE workspace_id = ${ws}
    ORDER BY (status IN ('running', 'paused')) DESC, started_at DESC LIMIT 1`;
  return rows[0] ? toRun(rows[0]) : null;
}

/** Count of approved snapshot claims a role may not see (integer only). */
export async function countWithheld(ws: string, role: RoleKey, section = "all"): Promise<number> {
  const [row] = await withRole(ws, role, (tx) =>
    tx`SELECT count_withheld(${ws}::uuid, ${role}, ${section}) AS n`);
  return Number(row?.n ?? 0);
}

/** Append-only audit trail of admin and user actions. */
export async function audit(ws: string | null, actor: string, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  await db()`
    INSERT INTO audit_log (workspace_id, actor, action, detail)
    VALUES (${ws}, ${actor}, ${action}, ${JSON.stringify(detail)}::jsonb)`;
}

export interface ClaimCounters {
  byTrust: Record<string, number>;
  byState: Record<string, number>;
  droppedBySource: Record<string, number>;
}

/** Ledger counters from a claim list (already role-filtered by the caller). */
export function claimCounters(claims: Claim[], sourceNames: Record<string, string> = {}): ClaimCounters {
  const byTrust: Record<string, number> = {};
  const byState: Record<string, number> = {};
  const droppedBySource: Record<string, number> = {};
  for (const c of claims) {
    byState[c.state] = (byState[c.state] ?? 0) + 1;
    if (c.state !== "dropped") byTrust[c.trust] = (byTrust[c.trust] ?? 0) + 1;
    if (c.state === "dropped") {
      const kinds = c.sourceKinds.length ? c.sourceKinds : ["unknown"];
      for (const k of kinds) {
        const name = sourceNames[k] ?? k;
        droppedBySource[name] = (droppedBySource[name] ?? 0) + 1;
      }
    }
  }
  return { byTrust, byState, droppedBySource };
}
