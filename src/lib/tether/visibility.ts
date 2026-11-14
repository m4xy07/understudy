// Who may see a segment: the stored side of content-level confidentiality.
// Contract: docs/ARCHITECTURE.md section 4a, docs/round3/specs/02_confidentiality.md sections 7 and 8.
//
//   listSensitive / sensitiveSummary   what the "Sensitive content" panel shows a role (read under RLS)
//   countLimited                       how many limited messages a role cannot read (integer only)
//   setSegmentVisibility               the approver widens or limits one segment, with a written reason
//   reclassify                         the pipeline's check of segments an older rules version stored
//
// Segments are immutable: every change here is a new version row. Readers only see the head
// version (RLS), so an older, wider version is never readable again.
// The only code path that ever adds a role to a stored segment is the approver's widen below.
import { db } from "@/lib/db/client";
import { toSegment } from "@/lib/db/mappers";
import { audit } from "@/lib/db/queries";
import { withRole } from "@/lib/db/withRole";
import { callJson, modelAvailable } from "@/lib/model/client";
import { getWorkspacePack, roleLabel, type ResolvedPack } from "@/lib/pack";
import type { RoleKey, Segment, SensitivityCategory, SensitivityStage } from "@/lib/types";
import {
  CATEGORIES, CLASSIFIER_VERSION, classifyByRules, nameParts, narrowForSensitivity, narrowRoleSet, packSensitivity, reasonFor,
  type NarrowResult, type SensitivityModelCall,
} from "./sensitivity";

type Sql = ReturnType<typeof db>;
type Row = Record<string, unknown>;

/** The classifier's model call through the shared client: cached answers first, cache only when the model is down. */
export async function sensitivityModelCall(): Promise<SensitivityModelCall> {
  const up = await modelAvailable();
  return (o) => callJson({
    system: o.system,
    user: o.user,
    schema: o.schema,
    jsonSchemaName: o.jsonSchemaName,
    jsonSchema: o.jsonSchema,
    cacheOnly: !up,
    timeoutMs: o.timeoutMs,
    retries: 1,
  });
}

/** Name parts of everyone in the workspace, and per person id, for the rule stage. */
export async function knownNamesFor(ws: string): Promise<{ knownNames: string[]; authorNames: Record<string, string[]> }> {
  const rows = await db()`SELECT id, display_name, aliases FROM people WHERE workspace_id = ${ws}`;
  const authorNames: Record<string, string[]> = {};
  const all: string[] = [];
  for (const r of rows) {
    const names = [String(r.display_name), ...((r.aliases as string[]) ?? [])];
    authorNames[String(r.id)] = nameParts(names);
    all.push(...names);
  }
  return { knownNames: nameParts(all), authorNames };
}

/**
 * For text typed into the app after ingest (a leaver's answer, a neighbour's answer, a successor
 * finding): the role set it may be stored with. Rules only (no model call on the save path): a
 * strong hit limits it to the pack's roles for that category, a borderline one is held for the
 * approver. Never wider than `roleSet`. Store the returned role set on the segment and its claim,
 * and the sensitivity fields on the segment (segmentSensitivityFields).
 */
export async function narrowTypedText(
  ws: string, text: string, kind: Segment["kind"], roleSet: readonly RoleKey[], sourceKind: Segment["sourceKind"] = "interview",
): Promise<NarrowResult> {
  const pack = await getWorkspacePack(ws);
  const { knownNames } = await knownNamesFor(ws);
  return narrowForSensitivity(text, kind, roleSet, packSensitivity(pack), knownNames, sourceKind);
}

/** The sensitivity columns of a new segment row, from a narrowTypedText result (or none). */
export function segmentSensitivityFields(n: NarrowResult | null | undefined): {
  sensitivity: string[]; stage: string | null; reason: string | null; roleSetOriginal: RoleKey[] | null; classifierVersion: number;
} {
  return {
    sensitivity: n?.categories ?? [], stage: n?.stage ?? null, reason: n?.reason ?? null,
    roleSetOriginal: n?.roleSetOriginal ?? null, classifierVersion: CLASSIFIER_VERSION,
  };
}

/** One sentence for the person who typed it, when their text was limited; null otherwise. */
export function limitedNote(n: NarrowResult | null | undefined): string | null {
  if (!n?.roleSetOriginal) return null;
  return n.stage === "held"
    ? "It may hold sensitive content, so it is held for the approver to look at."
    : "It holds sensitive content, so fewer roles can read it.";
}

// ---------------------------------------------------------------------------------------------
// Reading

export interface SensitiveRow {
  segmentId: string;
  version: number;
  sourceId: string;
  sourceName: string;
  ts: string;
  authorName: string | null;
  text: string;
  categories: SensitivityCategory[];
  stage: SensitivityStage | null;
  reason: string | null;
  roleSet: RoleKey[];
  /** The source role set the segment had before it was limited. */
  roleSetOriginal: RoleKey[];
  /** The approver's written reason on this version, when the approver made it. */
  note: string | null;
  changedAt: string;
}

/** Limited (and widened) segments as `role` may read them: head versions only, under RLS. */
export async function listSensitive(ws: string, role: RoleKey): Promise<SensitiveRow[]> {
  const rows = await withRole(ws, role, (tx) => tx`
    SELECT * FROM segments
    WHERE workspace_id = ${ws} AND sensitivity <> '{}' AND role_set_original IS NOT NULL
    ORDER BY ts, id`);
  if (!rows.length) return [];
  const sql = db();
  const sources = new Map((await sql`SELECT id, name FROM sources WHERE workspace_id = ${ws}`).map((r) => [String(r.id), String(r.name)]));
  const people = new Map((await sql`SELECT id, display_name FROM people WHERE workspace_id = ${ws}`).map((r) => [String(r.id), String(r.display_name)]));
  return rows.map((r) => {
    const s = toSegment(r as Row);
    return {
      segmentId: s.id,
      version: s.version,
      sourceId: s.sourceId,
      sourceName: sources.get(s.sourceId) ?? s.sourceId,
      ts: s.ts,
      authorName: s.authorId ? (people.get(s.authorId) ?? null) : null,
      text: s.text,
      categories: s.sensitivity ?? [],
      stage: s.sensitivityStage ?? null,
      reason: s.sensitivityReason ?? null,
      roleSet: s.roleSet,
      roleSetOriginal: s.roleSetOriginal ?? s.roleSet,
      note: s.visibilityNote ?? null,
      changedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
    };
  });
}

/** How many limited messages in sources the role can open are hidden from it. An integer, nothing else. */
export async function countLimited(ws: string, role: RoleKey): Promise<number> {
  const [row] = await withRole(ws, role, (tx) => tx`SELECT count_limited(${ws}::uuid, ${role}) AS n`);
  return Number(row?.n ?? 0);
}

export interface SensitiveSummary {
  rows: SensitiveRow[];
  /** Rows this role can read that are still limited. */
  limited: number;
  held: number;
  widened: number;
  /** Limited messages this role cannot read (count only). */
  hidden: number;
  /** Limited messages per source id. Filled for the approver only. */
  perSource: Record<string, number>;
}

export async function sensitiveSummary(ws: string, role: RoleKey): Promise<SensitiveSummary> {
  const pack = await getWorkspacePack(ws);
  const [all, hidden] = await Promise.all([listSensitive(ws, role), countLimited(ws, role)]);
  // A widened message is no longer limited: only the approver, who can limit it again, keeps the row.
  const rows = role === pack.approverRole ? all : all.filter((r) => r.stage !== "widened");
  const perSource: Record<string, number> = {};
  if (role === pack.approverRole) {
    for (const r of rows) if (r.stage !== "widened") perSource[r.sourceId] = (perSource[r.sourceId] ?? 0) + 1;
  }
  return {
    rows,
    limited: rows.filter((r) => r.stage !== "widened").length,
    held: rows.filter((r) => r.stage === "held").length,
    widened: rows.filter((r) => r.stage === "widened").length,
    hidden,
    perSource,
  };
}

/** True when a segment's visibility changed after the latest snapshot was approved. */
export async function visibilityChangedSinceSnapshot(ws: string): Promise<boolean> {
  // Compared in the database: a JavaScript date string drops the milliseconds, so a change made in
  // the same second as the approval used to look "not after" it.
  const [row] = await db()`
    SELECT coalesce(
      (SELECT max(created_at) FROM segments WHERE workspace_id = ${ws} AND sensitivity_stage IN ('manual', 'widened'))
        > (SELECT max(approved_at) FROM snapshots WHERE workspace_id = ${ws}),
      false) AS changed`;
  return row?.changed === true;
}

// ---------------------------------------------------------------------------------------------
// Writing

export type VisibilityChange =
  | { action: "widen"; roles: RoleKey[] | "source"; reason: string }
  | { action: "limit"; categories: SensitivityCategory[]; reason: string };

export type VisibilityResult =
  | {
    ok: true; version: number; changed: boolean;
    /** The run to execute, or null when there is nothing for the caller to execute. */
    runId: string | null;
    /**
     * True when a run was already live: the caller must NOT execute. The change is applied by a
     * full run that starts by itself when the live one ends (requestRerun).
     */
    queued: boolean;
  }
  | { ok: false; error: string };

export const MIN_REASON_CHARS = 10;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

async function headSegment(sql: Sql, ws: string, segmentId: string): Promise<Segment | null> {
  const [row] = await sql`
    SELECT * FROM segments WHERE workspace_id = ${ws} AND id = ${segmentId} ORDER BY version DESC LIMIT 1`;
  return row ? toSegment(row as Row) : null;
}

interface NewVersion {
  roleSet: RoleKey[];
  sensitivity: SensitivityCategory[];
  stage: SensitivityStage;
  reason: string | null;
  roleSetOriginal: RoleKey[] | null;
  note: string | null;
  actor: string;
}

/** Insert version head + 1 with the same id, text and meta. False when another request wrote it first. */
async function insertVersion(sql: Sql, ws: string, head: Segment, v: NewVersion): Promise<boolean> {
  const rows = await sql`
    INSERT INTO segments (workspace_id, id, version, source_id, source_kind, kind, ts, author_id, thread, position,
      text, text_hash, role_set, meta, sensitivity, sensitivity_stage, sensitivity_reason, role_set_original,
      visibility_note, visibility_actor, classifier_version)
    SELECT workspace_id, id, ${head.version + 1}, source_id, source_kind, kind, ts, author_id, thread, position,
      text, text_hash, ${v.roleSet}::text[], meta, ${v.sensitivity}::text[], ${v.stage}, ${v.reason},
      ${v.roleSetOriginal}::text[], ${v.note}, ${v.actor}, ${CLASSIFIER_VERSION}
    FROM segments WHERE workspace_id = ${ws} AND id = ${head.id} AND version = ${head.version}
    ON CONFLICT (workspace_id, id, version) DO NOTHING
    RETURNING version`;
  return rows.length > 0;
}

function parseResults(v: unknown): { claimIds?: string[]; note?: string }[] {
  let x = v;
  for (let i = 0; i < 2 && typeof x === "string"; i++) {
    try { x = JSON.parse(x); } catch { return []; }
  }
  return Array.isArray(x) ? (x as { claimIds?: string[]; note?: string }[]) : [];
}

/**
 * A segment's role set got smaller: everything derived from it shrinks in the same transaction,
 * with no re-run needed. Claims that cite it (and their frozen copies in every snapshot) lose the
 * removed roles; open gap questions are rebuilt by the next run; stand-in notes that may quote
 * those claims are blanked. Recovery rows (option cards with quotes, rebuilt procedures, the
 * question written for a neighbour) and successor findings that rest on the segment or on those
 * claims shrink too. Returns the ids of the claims it narrowed.
 */
async function narrowDerived(sql: Sql, ws: string, segmentId: string, roleSet: readonly RoleKey[]): Promise<string[]> {
  const like = `%${segmentId}%`;
  const claims = await sql`
    UPDATE claims SET role_set = ARRAY(SELECT r FROM unnest(role_set) AS r WHERE r = ANY(${roleSet as RoleKey[]}::text[])), updated_at = now()
    WHERE workspace_id = ${ws} AND citations::text LIKE ${like}
    RETURNING id`;
  const ids = claims.map((r) => String(r.id));
  await sql`
    UPDATE attest_dropped SET role_set = ARRAY(SELECT r FROM unnest(role_set) AS r WHERE r = ANY(${roleSet as RoleKey[]}::text[]))
    WHERE workspace_id = ${ws} AND citations::text LIKE ${like}`;
  await narrowRecoveryAndFindings(sql, ws, segmentId, ids, roleSet);
  if (!ids.length) return ids;
  await sql`
    UPDATE snapshot_claims SET role_set = ARRAY(SELECT r FROM unnest(role_set) AS r WHERE r = ANY(${roleSet as RoleKey[]}::text[]))
    WHERE workspace_id = ${ws} AND claim_id = ANY(${ids}::text[])`;
  await sql`DELETE FROM gap_questions WHERE workspace_id = ${ws} AND answered_claim_id IS NULL`;
  const runs = await sql`
    SELECT DISTINCT ON (role) id, results FROM test_runs WHERE workspace_id = ${ws} ORDER BY role, created_at DESC`;
  for (const run of runs) {
    const results = parseResults(run.results);
    let touched = false;
    for (const r of results) {
      if (r.note && (r.claimIds ?? []).some((id) => ids.includes(id))) {
        r.note = "";
        touched = true;
      }
    }
    if (touched) {
      await sql`UPDATE test_runs SET results = ${JSON.stringify(results)}::jsonb WHERE workspace_id = ${ws} AND id = ${String(run.id)}`;
    }
  }
  return ids;
}

/**
 * The re-run after a visibility change. `runId` is set only when the caller must execute it; when
 * a run is already live nothing is executed here (a second slice on the same run would do its
 * steps twice) and a full run is queued behind it instead.
 */
/**
 * Recovery rows and findings keep their own role sets (RLS reads those, not the claim's), so a
 * limit has to reach them in the same transaction:
 *   * a row that points at a narrowed claim, or whose stored detail quotes the segment or one of
 *     those claims (option evidence, trace steps), loses the removed roles;
 *   * every option row of a gap those claims belong to loses them too (a proposal is written from
 *     all the record claims of its gap);
 *   * the question written for a neighbour on such a gap is built from those claims: the row loses
 *     the removed roles, and if the neighbour who was asked is one of them the row is removed
 *     (they can no longer be asked about it; the next ladder build decides again);
 *   * a finding whose evidence is the segment, or whose claim was narrowed, loses the removed roles.
 */
async function narrowRecoveryAndFindings(
  sql: Sql, ws: string, segmentId: string, claimIds: readonly string[], roleSet: readonly RoleKey[],
): Promise<void> {
  const keep = roleSet as RoleKey[];
  const ids = claimIds as string[];
  const patterns = [`%${segmentId}%`, ...ids.map((id) => `%${id}%`)];
  await sql`
    UPDATE recovery_steps SET role_set = ARRAY(SELECT r FROM unnest(role_set) AS r WHERE r = ANY(${keep}::text[])), updated_at = now()
    WHERE workspace_id = ${ws} AND (claim_id = ANY(${ids}::text[]) OR detail::text LIKE ANY(${patterns}::text[]))`;
  await sql`
    UPDATE findings SET role_set = ARRAY(SELECT r FROM unnest(role_set) AS r WHERE r = ANY(${keep}::text[]))
    WHERE workspace_id = ${ws} AND (segment_id = ${segmentId} OR attachment_segment_id = ${segmentId} OR claim_id = ANY(${ids}::text[]))`;
  if (!ids.length) return;
  // The gaps those claims belong to: by the open question that names them, and by entity.
  const gaps = await sql`
    SELECT DISTINCT r.id AS responsibility_id FROM responsibilities r
    WHERE r.workspace_id = ${ws} AND (
      r.entities && ARRAY(SELECT entity FROM claims WHERE workspace_id = ${ws} AND id = ANY(${ids}::text[]))
      OR r.id IN (SELECT responsibility_id FROM gap_questions WHERE workspace_id = ${ws} AND claim_ids && ${ids}::text[]))`;
  const respIds = gaps.map((g) => String(g.responsibility_id));
  if (!respIds.length) return;
  await sql`
    DELETE FROM recovery_steps
    WHERE workspace_id = ${ws} AND responsibility_id = ANY(${respIds}::text[]) AND kind = 'neighbour' AND status = 'asked'
      AND question_text IS NOT NULL AND NOT (target_role = ANY(${keep}::text[]))`;
  await sql`
    UPDATE recovery_steps SET role_set = ARRAY(SELECT r FROM unnest(role_set) AS r WHERE r = ANY(${keep}::text[])), updated_at = now()
    WHERE workspace_id = ${ws} AND responsibility_id = ANY(${respIds}::text[])
      AND (kind = 'option' OR (kind = 'neighbour' AND question_text IS NOT NULL))`;
}

async function startRerun(ws: string): Promise<{ runId: string | null; queued: boolean }> {
  try {
    const { requestRerun } = await import("@/lib/pipeline/run");
    const started = await requestRerun(ws);
    return { runId: started.alreadyRunning ? null : started.runId, queued: started.queued };
  } catch (err) {
    console.error(`[visibility ${ws}] could not start the re-run`, err);
    return { runId: null, queued: false };
  }
}

/** What the approver is told. A change made while a run is working is applied by the run after it. */
export function visibilityMessage(verb: "Widened" | "Limited", res: { changed: boolean; runId: string | null; queued: boolean }): string {
  if (!res.changed) return `Already ${verb.toLowerCase()}.`;
  if (res.queued) {
    const now = verb === "Limited" ? " The message is already hidden from the roles you removed." : "";
    return `${verb}.${now} A run is in progress, so the change applies at the next run, which starts by itself when this one ends.`;
  }
  if (!res.runId) return `${verb}. The re-run could not be started: press Run to apply the change.`;
  return `${verb}. Re-running the steps that used this message.`;
}

function orderRoles(roles: readonly RoleKey[], pack: Pick<ResolvedPack, "roleOrder">): RoleKey[] {
  return pack.roleOrder.filter((r) => roles.includes(r));
}

/**
 * The approver changes who sees one segment. Every rule is checked here, on the server:
 * only the approver, a written reason, a widen never beyond the source's own roles.
 * The caller runs the returned pipeline run (executeRun), usually inside after().
 */
export async function setSegmentVisibility(
  ws: string, segmentId: string, change: VisibilityChange, actor: RoleKey,
): Promise<VisibilityResult> {
  const pack = await getWorkspacePack(ws);
  if (actor !== pack.approverRole) {
    return { ok: false, error: `Only the approver (${roleLabel(pack.approverRole, pack)}) can change who sees this.` };
  }
  const reason = (change.reason ?? "").trim();
  if (reason.length < MIN_REASON_CHARS) return { ok: false, error: `Write why, in at least ${MIN_REASON_CHARS} characters.` };
  const sql = db();
  const head = await headSegment(sql, ws, segmentId);
  if (!head) return { ok: false, error: "Message not found." };

  if (change.action === "widen") {
    const original = head.roleSetOriginal;
    if (!original) return { ok: false, error: "This message is not limited." };
    const wanted = change.roles === "source" ? original : change.roles;
    if (!Array.isArray(wanted) || wanted.some((r) => !original.includes(r)) || head.roleSet.some((r) => !wanted.includes(r))) {
      return { ok: false, error: "You can only widen back to the roles of the source." };
    }
    const target = orderRoles(wanted, pack);
    if (sameSet(target, head.roleSet)) {
      // A second click on the same form: the first one already did it.
      if (head.sensitivityStage === "widened") return { ok: true, version: head.version, runId: null, queued: false, changed: false };
      return { ok: false, error: "Pick at least one more role to widen to." };
    }
    const inserted = await insertVersion(sql, ws, head, {
      roleSet: target,
      sensitivity: head.sensitivity ?? [],
      stage: "widened",
      reason: head.sensitivityReason ?? null,
      roleSetOriginal: original,
      note: reason,
      actor,
    });
    if (!inserted) return { ok: true, version: head.version + 1, runId: null, queued: false, changed: false };
    await audit(ws, actor, "widen_segment", {
      segmentId, fromVersion: head.version, toVersion: head.version + 1,
      from: head.roleSet, to: target, categories: head.sensitivity ?? [], reason,
    });
    return { ok: true, version: head.version + 1, ...(await startRerun(ws)), changed: true };
  }

  const categories = CATEGORIES.filter((c) => (change.categories ?? []).includes(c));
  if (!categories.length) return { ok: false, error: "Pick what kind of content this is." };
  const ps = packSensitivity(pack);
  const target = orderRoles(narrowRoleSet(head.roleSet, categories, ps), pack);
  if (sameSet(target, head.roleSet)) {
    if (head.sensitivityStage === "manual") return { ok: true, version: head.version, runId: null, queued: false, changed: false };
    return { ok: false, error: "This message is already limited to those roles." };
  }
  const narrowed = await sql.begin(async (tx) => {
    const inserted = await insertVersion(tx as unknown as Sql, ws, head, {
      roleSet: target,
      sensitivity: categories,
      stage: "manual",
      reason: reasonFor(categories[0]),
      roleSetOriginal: head.roleSetOriginal ?? head.roleSet,
      note: reason,
      actor,
    });
    if (!inserted) return null;
    return narrowDerived(tx as unknown as Sql, ws, segmentId, target);
  }) as string[] | null;
  if (narrowed === null) return { ok: true, version: head.version + 1, runId: null, queued: false, changed: false };
  await audit(ws, actor, "limit_segment", {
    segmentId, fromVersion: head.version, toVersion: head.version + 1,
    from: head.roleSet, to: target, categories, reason, claims: narrowed.length,
  });
  return { ok: true, version: head.version + 1, ...(await startRerun(ws)), changed: true };
}

// ---------------------------------------------------------------------------------------------
// Reclassify (the pipeline's connect step)

/**
 * Look again at head segments an older rules version stored (or that another module wrote without
 * classifying). Rules only. A segment the rules now limit gets a new, narrower version and its
 * derived rows shrink at once. Nothing is ever widened here, and the approver's own decisions
 * (manual, widened) are never touched.
 */
export async function reclassify(ws: string): Promise<{ looked: number; narrowed: number }> {
  const sql = db();
  const rows = await sql`
    SELECT s.* FROM (
      SELECT DISTINCT ON (id) * FROM segments WHERE workspace_id = ${ws} ORDER BY id, version DESC
    ) s
    LEFT JOIN sensitivity_checked k ON k.workspace_id = s.workspace_id AND k.segment_id = s.id
    WHERE s.classifier_version < ${CLASSIFIER_VERSION}
      AND coalesce(s.sensitivity_stage, '') NOT IN ('manual', 'widened')
      AND coalesce(k.classifier_version, 0) < ${CLASSIFIER_VERSION}`;
  if (!rows.length) return { looked: 0, narrowed: 0 };
  const pack = await getWorkspacePack(ws);
  const ps = packSensitivity(pack);
  const names = await knownNamesFor(ws);
  const segments = rows.map((r) => toSegment(r as Row));
  const decisions = classifyByRules(segments, { ...names, pack: ps });
  let narrowed = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const d = decisions[i];
    const target = d.outcome === "sensitive" ? orderRoles(narrowRoleSet(seg.roleSet, d.categories, ps), pack) : seg.roleSet;
    if (d.outcome === "sensitive" && !sameSet(target, seg.roleSet)) {
      const done = await sql.begin(async (tx) => {
        const inserted = await insertVersion(tx as unknown as Sql, ws, seg, {
          roleSet: target,
          sensitivity: d.categories,
          stage: d.stage ?? "rule",
          reason: d.reason,
          roleSetOriginal: seg.roleSetOriginal ?? seg.roleSet,
          note: null,
          actor: "system",
        });
        if (inserted) await narrowDerived(tx as unknown as Sql, ws, seg.id, target);
        return inserted;
      });
      if (done) narrowed++;
    }
  }
  await sql`
    INSERT INTO sensitivity_checked (workspace_id, segment_id, classifier_version)
    SELECT ${ws}, x, ${CLASSIFIER_VERSION} FROM unnest(${segments.map((s) => s.id)}::text[]) AS x
    ON CONFLICT (workspace_id, segment_id) DO UPDATE SET classifier_version = EXCLUDED.classifier_version, checked_at = now()`;
  if (narrowed) await audit(ws, "system", "reclassify_sensitivity", { looked: segments.length, narrowed, version: CLASSIFIER_VERSION });
  return { looked: segments.length, narrowed };
}
