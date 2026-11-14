// Unreachable-leaver recovery: database and model glue around the pure cores
// (tether/graph, tether/traces, lacuna/core/ladder, lacuna/core/options).
// Contract: docs/ARCHITECTURE.md section 4, "Recovery".
//
// When the approver marks the leaver as unreachable, every open gap question walks three rungs:
//   1. people who worked next to the leaver, asked only if their role may see the topic
//      (answers stored as Second-hand claims);
//   2. procedures and states rebuilt from workflow files, CI runs, commits and the calendar
//      (stored as Inferred claims, every step cited and checked by Attest's exact-quote rule);
//   3. ranked options for what stays open (stored only in recovery_steps, never as claims).
// Every role-scoped read goes through withRole; recovery_steps is read under RLS.
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db/client";
import { toClaim } from "@/lib/db/mappers";
import {
  audit, getLatestTestRun, getWorkspace, listClaims, listPeople, listPlanItems, listResponsibilities, listSegments,
} from "@/lib/db/queries";
import { withRole } from "@/lib/db/withRole";
import { authority, entityLabel, getWorkspacePack, roleLabel, type ResolvedPack } from "@/lib/pack";
import { attestPack, claimId as makeClaimId, tierFor } from "@/lib/attest";
import { isRecordOrigin, PERSON_SEGMENT_KINDS } from "@/lib/attest/core/origins";
import { importanceOf as attestImportance } from "@/lib/attest/core/rules";
import { isExactQuote, verifyDrafts } from "@/lib/attest/core/verify";
import { callJson, modelAvailable } from "@/lib/model/client";
import { ensureRoleHolders } from "@/lib/roles";
import { sha256Hex } from "@/lib/text/norm";
import {
  buildGraph, entitySegmentIndex, neighbourReason, neighbourScores, toGraphSegment, type CollabGraph, type GraphSegment,
  type NeighbourCounts, type NeighbourScore,
} from "@/lib/tether/graph";
import { readTraces, type Trace, type TraceKind } from "@/lib/tether/traces";
import type {
  Attribute, CheckResult, Claim, Coverage, Importance, Person, Responsibility, RoleKey, Scores, Segment, SourceKind, TestRun, Trust,
} from "@/lib/types";
import { leaverName, leaverPersonIds, toLacunaPack } from "./adapt";
import { checksByResp, checksFor } from "./core/checks";
import {
  defaultAnswerRoleSet, gapState, ladderSummary, looksLikeNoAnswer, narrowAnswerRoleSet, neighbourAnswerToDrafts,
  neighbourQuestionText, neighbourRowRoleSet, openRoles, projectLeaverRun, routeCandidates, traceServes, traceToDraft,
  type GapState, type LadderSummary, type NeighbourPlan,
} from "./core/ladder";
import {
  buildOptionsPrompt, conflictOptions, evaluateOptions, OPTIONS_JSON_SCHEMA, OPTIONS_JSON_SCHEMA_NAME, OptionsOutputSchema,
  patternOptions, rankOptions, weakOptions, type OptionCandidate, type OptionEvidence, type OptionSource,
} from "./core/options";
import { gapKey, type LacunaCheck } from "./core/pack";
import { namedOwnersFromPlan, openBlockingGaps } from "./core/plan";
import { evidenceMix, scoreDelta } from "./core/scores";
import {
  answerQuestion, buildQuestions, claimMeta, listQuestions, runTest, visibleClaims, workspaceNow, type QuestionView,
} from "./index";
import { maskAnswer, persistAnswer } from "./persist";

const RECOVERY_SOURCE = "src_recovery";
const RECOVERY_SOURCE_NAME = "Recovery answers";
/** responsibility_id of the rows that hold a trace's steps for the "Rebuilt procedures" list (no gap). */
const LIBRARY = "";
const MODEL_CONCURRENCY = 4;
const GRAPH_KINDS = ["message", "commit", "file", "task", "note", "event"];

type Sql = ReturnType<typeof db>;

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export interface RecoveryState {
  on: boolean;
  at: string | null;
  note: string | null;
  baselineRunId: string | null;
}

export async function recoveryState(ws: string): Promise<RecoveryState> {
  const w = await getWorkspace(ws);
  return {
    on: Boolean(w?.leaverUnreachable),
    at: w?.leaverUnreachableAt ?? null,
    note: w?.leaverUnreachableNote ?? null,
    baselineRunId: w?.recoveryBaselineRun ?? null,
  };
}

export type SwitchResult = { ok: true; message: string; on: boolean; gaps: number } | { ok: false; error: string };

function names(pack: ResolvedPack): { leaver: string; approver: string } {
  return { leaver: leaverName(pack) || "The leaver", approver: roleLabel(pack.approverRole, pack) };
}

/**
 * The approver marks the leaver as unreachable (or reachable again). Both are audited. Switching
 * on stores the successor run that is latest at that moment (the baseline of the before and after
 * panel) and builds the ladder. Switching off restores the normal Ask flow; Second-hand answers
 * and rebuilt procedures stay, with their labels. Safe to press twice.
 */
export async function setLeaverUnreachable(ws: string, on: boolean, actor: RoleKey, note?: string): Promise<SwitchResult> {
  const sql = db();
  const pack = await getWorkspacePack(ws);
  const n = names(pack);
  if (actor !== pack.approverRole) return { ok: false, error: `Only ${n.approver} can change this.` };
  const state = await recoveryState(ws);

  if (!on) {
    if (state.on) {
      const changed = await sql`
        UPDATE workspaces SET leaver_unreachable = false WHERE id = ${ws} AND leaver_unreachable = true RETURNING id`;
      if (changed.length > 0) await audit(ws, actor, "recovery_off", { since: state.at });
    }
    return {
      ok: true, on: false, gaps: 0,
      message: `Recovery is off. ${n.leaver} can answer again. Second-hand answers and rebuilt procedures stay, with their labels.`,
    };
  }

  const successor = pack.successorRole as RoleKey;
  let open = (await listQuestions(ws)).filter((q) => !q.answeredClaimId);
  if (open.length === 0 && !state.on) {
    // No question list yet: build it (this runs the successor test first when there is none).
    open = (await buildQuestions(ws) as QuestionView[]).filter((q) => !q.answeredClaimId);
  }
  if (open.length === 0) return { ok: false, error: "Run the successor test first. There are no gaps to work on yet." };

  if (!state.on) {
    const baseline = await getLatestTestRun(ws, successor);
    const reason = (note ?? "").trim().slice(0, 500) || null;
    const changed = await sql`
      UPDATE workspaces SET leaver_unreachable = true, leaver_unreachable_at = now(), leaver_unreachable_note = ${reason},
        recovery_baseline_run = ${baseline?.id ?? null}
      WHERE id = ${ws} AND leaver_unreachable = false RETURNING id`;
    if (changed.length > 0) await audit(ws, actor, "recovery_on", { note: reason, baselineRunId: baseline?.id ?? null, gaps: open.length });
  }
  const built = await buildLadder(ws);
  return {
    ok: true, on: true, gaps: built.gaps,
    message: `Recovery is on. ${built.gaps} ${built.gaps === 1 ? "gap is" : "gaps are"} being worked without ${n.leaver}. This is in the audit log.`,
  };
}

// ---------------------------------------------------------------------------
// Ladder: build
// ---------------------------------------------------------------------------

function stepId(responsibilityId: string, checkKey: string, rung: number, target: string): string {
  return `rs_${sha256Hex(`${responsibilityId}|${checkKey}|${rung}|${target}`).slice(0, 12)}`;
}

interface StepRow {
  id: string;
  responsibility_id: string;
  check_key: string;
  rung: number;
  kind: "neighbour" | "trace" | "option" | "none";
  position: number;
  target_person: string | null;
  target_role: string | null;
  target_ref: string | null;
  status: string;
  score: number | null;
  reason: string;
  question_text: string | null;
  detail: Record<string, unknown>;
  claim_id: string | null;
  role_set: RoleKey[];
}

function row(base: Pick<StepRow, "responsibility_id" | "check_key" | "rung" | "kind" | "status" | "role_set"> & Partial<StepRow> & { target: string }): StepRow {
  const { target, ...rest } = base;
  return {
    id: stepId(base.responsibility_id, base.check_key, base.rung, target),
    position: 0, target_person: null, target_role: null, target_ref: null, score: null, reason: "", question_text: null,
    detail: {}, claim_id: null,
    ...rest,
  };
}

function nameKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function byNumericId(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/**
 * person record id -> node id. Several records of one role holder (a chat export and a code host)
 * share a node; people without a role stay separate records (identity merges need an exact email).
 */
function canonMap(byRole: Map<RoleKey, string[]>, pack: ResolvedPack, people: readonly Person[]): Map<string, string> {
  const nameOf = new Map(people.map((p) => [p.id, p.displayName]));
  const canon = new Map<string, string>();
  for (const [role, ids] of byRole) {
    const sorted = [...ids].sort(byNumericId);
    const single = role === pack.leaverRole || (pack.roleHolders[role]?.length ?? 0) <= 1;
    const groups = new Map<string, string>();
    for (const id of sorted) {
      const key = single ? "*" : nameKey(nameOf.get(id) ?? id);
      if (!groups.has(key)) groups.set(key, id);
      if (!canon.has(id)) canon.set(id, groups.get(key)!);
    }
  }
  return canon;
}

export interface TraceStepView {
  n: number;
  text: string;
  kind: "quoted" | "derived";
  /** A quoted step whose quote Attest found word for word in the cited segment. */
  exact: boolean;
  segmentId: string | null;
  /** Index of the step's first citation in the claim's citation list (for the source page link). */
  cite: number;
  quote: string | null;
  path?: string;
  sha?: string;
}

interface StoredTrace {
  trace: Trace;
  claim: Claim;
  steps: TraceStepView[];
  quoted: number;
  total: number;
  isNew: boolean;
}

function importanceFor(entity: string, attribute: Attribute, resps: readonly Responsibility[], pack: ResolvedPack): Importance {
  const kinds = new Map(resps.filter((r) => r.entities.includes(entity)).map((r) => [r.kind, true]));
  if (kinds.size === 0) return attestImportance({ entity, attribute }, attestPack(pack));
  let w = 0;
  for (const r of resps) {
    if (!r.entities.includes(entity)) continue;
    for (const c of checksFor(r, toLacunaPack(pack))) if (c.attributes.includes(attribute)) w = Math.max(w, c.weight);
  }
  return w >= 5 ? "blocking" : w >= 3 ? "important" : "normal";
}

/**
 * Read the traces, pass each through Attest's verifier, and store it as an Inferred claim with
 * origin "trace". A trace whose quoted steps mostly fail the exact-quote check is discarded and
 * logged: something is wrong with the read. Idempotent (deterministic claim ids).
 */
async function storeTraces(
  sql: Sql, ws: string, pack: ResolvedPack, segments: Segment[], people: Person[], resps: Responsibility[],
  index: Map<string, Set<string>>, commitEntities: string[], now: string,
): Promise<StoredTrace[]> {
  const entities = pack.entities.map((e) => ({ key: e.key, label: e.label, aliases: [...(e.aliases ?? [])] }));
  const readable = segments.filter((s) => !PERSON_SEGMENT_KINDS.includes(s.kind));
  const traces = readTraces(readable, entities, people, {
    today: now, thresholds: pack.footprint, entityIndex: index, commitEntities,
  });
  const segsById = new Map(segments.map((s) => [s.id, s]));
  const apack = attestPack(pack);
  const existing = new Map(
    (await sql`SELECT * FROM claims WHERE workspace_id = ${ws} AND origin = 'trace'`).map(toClaim).map((c) => [c.id, c]),
  );
  const out: StoredTrace[] = [];

  for (const trace of traces) {
    const draft = traceToDraft(trace);
    const vr = verifyDrafts([draft], segsById, apack, ws);
    const verified = vr.claims[0];
    if (!verified) {
      await audit(ws, "system", "trace_discarded", { traceId: trace.id, kind: trace.kind, reason: vr.dropped[0]?.reason ?? "not verified" });
      continue;
    }
    let cite = 0;
    const seen = new Map<string, number>();
    const steps: TraceStepView[] = trace.steps.map((s) => {
      const first = s.citations[0];
      const key = first ? `${first.segmentId}\u0000${first.quote ?? ""}` : "";
      // Citations are de-duplicated by the verifier in order of first appearance.
      for (const c of s.citations) {
        const k = `${c.segmentId}\u0000${c.quote ?? ""}`;
        if (!seen.has(k)) seen.set(k, cite++);
      }
      const exact = s.kind === "quoted" && s.citations.length > 0
        && s.citations.every((c) => isExactQuote(c.quote, segsById.get(c.segmentId)?.text ?? ""));
      return {
        n: s.n, text: s.text, kind: s.kind, exact, segmentId: first?.segmentId ?? null, cite: seen.get(key) ?? 0,
        quote: first?.quote ?? null, ...(s.path ? { path: s.path } : {}), ...(s.sha ? { sha: s.sha } : {}),
      };
    });
    const quotedSteps = steps.filter((s) => s.kind === "quoted");
    const quoted = quotedSteps.filter((s) => s.exact).length;
    if (quotedSteps.length > 0 && quoted * 2 < quotedSteps.length) {
      await audit(ws, "system", "trace_discarded", { traceId: trace.id, kind: trace.kind, reason: `only ${quoted} of ${quotedSteps.length} quoted steps verified` });
      continue;
    }
    const importance = importanceFor(verified.entity, verified.attribute, resps, pack);
    const claim: Claim = {
      ...verified,
      entityLabel: entityLabel(verified.entity, pack) || verified.entityLabel,
      value: verified.value.slice(0, 1000),
      trust: "inferred",            // always, whatever the verifier computed
      origin: "trace",
      stateNote: `Rebuilt from the record: ${quoted} of ${steps.length} steps quoted`,
      importance,
    };
    claim.tier = tierFor(claim, pack);
    const prev = existing.get(claim.id);
    const sourceIds = [...new Set(claim.citations.filter((c) => c.accepted).map((c) => segsById.get(c.segmentId)?.sourceId).filter(Boolean))] as string[];
    const inserted = await sql`
      INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, state, state_note,
        role_set, valid_from, author_id, source_kinds, importance, tier, review, origin, source_ids)
      VALUES (${ws}, ${claim.id}, ${claim.entity}, ${claim.entityLabel}, ${claim.attribute}, ${claim.value}, ${claim.statement},
        ${JSON.stringify(claim.citations)}::jsonb, 'inferred', 'active', ${claim.stateNote}, ${claim.roleSet}::text[], ${claim.validFrom},
        ${claim.authorId}, ${claim.sourceKinds}::text[], ${claim.importance}, ${claim.tier}, 'pending', 'trace', ${sourceIds}::text[])
      ON CONFLICT (workspace_id, id) DO NOTHING RETURNING id`;
    let isNew = inserted.length > 0;
    if (isNew) {
      await sql`INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
        VALUES (${ws}, ${claim.id}, 'created', ${JSON.stringify({
          origin: "trace", traceId: trace.id, kind: trace.kind, trust: "inferred", quoted, steps: steps.length, roleSet: claim.roleSet,
        })}::jsonb, 'system')`;
      await audit(ws, "system", "trace_stored", { traceId: trace.id, claimId: claim.id, kind: trace.kind, entity: claim.entity, quoted, steps: steps.length });
    } else if (prev && prev.state !== "active" && prev.review !== "rejected") {
      // The same reading is back (for example after a re-ingest): make it live again.
      await sql`UPDATE claims SET state = 'active', state_note = ${claim.stateNote}, superseded_by = NULL, updated_at = now()
        WHERE workspace_id = ${ws} AND id = ${claim.id}`;
      isNew = true;
    }
    out.push({ trace, claim: prev ? { ...claim, review: prev.review, state: "active" } : claim, steps, quoted, total: steps.length, isNew });
  }

  // A trace claim that the record no longer gives (new runs, new commits) is replaced, not kept beside the new one.
  const current = out.map((t) => t.claim.id);
  await sql`
    UPDATE claims SET state = 'superseded', state_note = 'Replaced by a newer reading of the same history', updated_at = now()
    WHERE workspace_id = ${ws} AND origin = 'trace' AND state = 'active' AND NOT (id = ANY(${current}::text[]))`;
  return out;
}

export interface OptionDetail {
  value: string;
  sources: OptionSource[];
  why?: string;
  evidence: (OptionEvidence & { sourceName: string | null })[];
}

interface LadderContext {
  ws: string;
  pack: ResolvedPack;
  now: string;
  roles: RoleKey[];
  leaver: string;
}

async function proposeOptions(
  ctx: LadderContext, resp: Responsibility, check: LacunaCheck, question: string, record: Claim[], cacheOnly: boolean,
): Promise<{ candidates: OptionCandidate[]; unavailable: boolean }> {
  // One call per identical role set among the record claims, like Attest's batching: an option
  // can then only rest on claims that share one role set.
  const groups = new Map<string, Claim[]>();
  for (const c of record) {
    const k = [...c.roleSet].sort().join(",");
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const candidates: OptionCandidate[] = [];
  let unavailable = false;
  for (const k of [...groups.keys()].sort()) {
    const claims = groups.get(k)!;
    const { system, user } = buildOptionsPrompt(resp, check, question, claims);
    const res = await callJson({
      system, user, schema: OptionsOutputSchema, jsonSchemaName: OPTIONS_JSON_SCHEMA_NAME,
      jsonSchema: OPTIONS_JSON_SCHEMA as Record<string, unknown>, cacheOnly,
    });
    if (!res.ok) {
      unavailable = true;
      continue;
    }
    candidates.push(...evaluateOptions(res.data, new Map(claims.map((c) => [c.id, c]))));
  }
  return { candidates, unavailable };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export interface BuildLadderOptions {
  /**
   * Ask the model for option proposals (default true). They are asked once, at switch-on; a
   * refresh after an answer passes false and keeps the proposals already stored.
   */
  model?: boolean;
}

export interface BuildLadderResult {
  gaps: number;
  steps: number;
  counts: Record<string, number>;
}

/**
 * Build (or rebuild) the ladder for every open gap question. Deterministic step ids, upsert:
 * rows a person already answered or declined are never overwritten, and rows for gaps that left
 * the question list are removed unless answered. A rung that throws stores a "none" row with the
 * reason, so nothing fails silently.
 */
export async function buildLadder(ws: string, opts: BuildLadderOptions = {}): Promise<BuildLadderResult> {
  const sql = db();
  const pack = await getWorkspacePack(ws);
  const lpack = toLacunaPack(pack);
  const now = await workspaceNow(ws);
  const roles = pack.roleOrder as RoleKey[];
  const leaverRole = pack.leaverRole as RoleKey;
  const successor = pack.successorRole as RoleKey;
  const ctx: LadderContext = { ws, pack, now, roles, leaver: leaverName(pack) };

  const [questions, resps, people, segments, holders] = await Promise.all([
    listQuestions(ws), listResponsibilities(ws), listPeople(ws), listSegments(ws), ensureRoleHolders(ws),
  ]);
  const open = questions.filter((q) => !q.answeredClaimId);
  const respById = new Map(resps.map((r) => [r.id, r]));
  const gaps = open.flatMap((q) => {
    const resp = respById.get(q.responsibilityId);
    const check = resp ? checksFor(resp, lpack).find((c) => c.key === q.checkKey) : undefined;
    return resp && check ? [{ q, resp, check }] : [];
  });

  // ---- the collaboration graph: metadata only. This read never selects the text column.
  const metaRows = await sql`
    SELECT DISTINCT ON (id) id, source_kind, kind, ts, author_id, thread, position, role_set, meta
    FROM segments WHERE workspace_id = ${ws} AND kind = ANY(${GRAPH_KINDS}::text[])
    ORDER BY id, version DESC`;
  const gsegs: GraphSegment[] = metaRows.map((r) => toGraphSegment({
    id: String(r.id), sourceKind: r.source_kind as SourceKind, kind: r.kind as Segment["kind"],
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts), authorId: (r.author_id as string | null) ?? null,
    thread: String(r.thread), position: Number(r.position ?? 0), roleSet: (r.role_set as RoleKey[]) ?? [],
    meta: (typeof r.meta === "string" ? JSON.parse(r.meta) : r.meta) as Record<string, unknown>,
  }));
  const canon = canonMap(holders.byRole, pack, people);
  const node = (id: string) => canon.get(id) ?? id;
  const nodeRoles = new Map<string, RoleKey[]>();
  for (const [personId, rs] of holders.byPerson) {
    const n = node(personId);
    nodeRoles.set(n, [...new Set([...(nodeRoles.get(n) ?? []), ...rs])]);
  }
  const displayName = new Map(people.map((p) => [p.id, p.displayName]));
  const leaverIds = [...new Set([
    ...leaverPersonIds(people, leaverName(pack), pack.leaverPerson.aliases),
    ...(holders.byRole.get(leaverRole) ?? []),
  ])];
  const graphOpts = { now, windowMonths: pack.footprint.windowMonths, canon };
  const graph = buildGraph(gsegs, graphOpts);
  const roleGraphs = new Map<RoleKey, CollabGraph>();
  const graphFor = (role: RoleKey): CollabGraph => {
    let g = roleGraphs.get(role);
    if (!g) {
      g = buildGraph(gsegs.filter((s) => s.roleSet.includes(role)), graphOpts);
      roleGraphs.set(role, g);
    }
    return g;
  };

  // ---- topics: which segments concern an entity, from the citations of record claims (no text read here).
  let allClaims = await listClaims(ws);
  const recordClaims = allClaims.filter((c) => isRecordOrigin(c.origin));
  const index = entitySegmentIndex(recordClaims, gsegs);

  // ---- rung 2 first: traces become claims, then the successor is re-tested for what they touch.
  // Commit sequences are read for the entities of gaps that a procedure can answer, and kept for
  // every entity that already has one (a rebuild must not retire a stored reading).
  const keptCommitEntities = (await sql`SELECT detail FROM recovery_steps WHERE workspace_id = ${ws} AND responsibility_id = ${LIBRARY}`)
    .map((r) => (typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail ?? {}) as { traceKind?: string; entity?: string })
    .filter((d) => d.traceKind === "commit_sequence" && d.entity)
    .map((d) => String(d.entity));
  const commitEntities = [...new Set([
    ...gaps.filter((g) => g.check.attributes.includes("procedure")).flatMap((g) => g.resp.entities),
    ...keptCommitEntities,
  ])].sort();
  let stored: StoredTrace[] = [];
  let traceError: string | null = null;
  try {
    stored = await storeTraces(sql, ws, pack, segments, people, resps, index, commitEntities, now);
  } catch (err) {
    traceError = err instanceof Error ? err.message : String(err);
    console.error(`[recovery ${ws}] trace reader failed`, err);
  }
  const fresh = stored.filter((t) => t.isNew);
  if (fresh.length > 0) {
    const touched = resps.filter((r) => fresh.some((t) => r.entities.includes(t.claim.entity))).map((r) => r.id);
    if (touched.length > 0) {
      for (const role of pack.testRoles) await runTest(ws, role, { trigger: "recovery traces", only: touched });
    }
    allClaims = await listClaims(ws);
  }
  const latest = await getLatestTestRun(ws, successor);
  const coverageOf = new Map((latest?.results ?? []).map((r) => [gapKey(r.responsibilityId, r.checkKey), r.coverage]));
  const meta = await claimMeta(ws);
  const sourceNames = new Map((await sql`SELECT id, name FROM sources WHERE workspace_id = ${ws}`).map((r) => [String(r.id), String(r.name)]));
  const segSource = new Map(segments.map((s) => [s.id, s.sourceId]));
  const visibleByRole = new Map<RoleKey, Claim[]>();
  const visibleFor = async (role: RoleKey): Promise<Claim[]> => {
    if (!visibleByRole.has(role)) visibleByRole.set(role, await visibleClaims(ws, role));
    return visibleByRole.get(role)!;
  };

  const rows: StepRow[] = [];

  // ---- library rows: one per stored trace, so "Rebuilt procedures" can list it whether or not a gap needs it.
  for (const t of stored) {
    rows.push(row({
      responsibility_id: LIBRARY, check_key: LIBRARY, rung: 2, kind: "trace", status: "found", target: t.trace.id,
      target_ref: t.trace.id, claim_id: t.claim.id, role_set: t.claim.roleSet,
      detail: { title: t.trace.title, sourceLabel: t.trace.sourceLabel, traceKind: t.trace.kind, steps: t.steps, quoted: t.quoted, total: t.total, entity: t.claim.entity, attribute: t.claim.attribute },
    }));
  }

  // ---- model availability for option proposals (M2), asked once.
  const wantModel = opts.model !== false;
  const modelOff = process.env.LACUNA_MODEL === "off"; // same switch the stand-in honours: no model call at all
  const modelUp = wantModel && !modelOff ? await modelAvailable() : false;
  const existingModel = new Map<string, OptionCandidate[]>();
  const existingRulesOnly = new Set<string>();
  if (!wantModel) {
    // A refresh keeps what the one model pass at switch-on gave: its proposals and its "unavailable" note.
    const kept = await sql`
      SELECT responsibility_id, check_key, detail FROM recovery_steps
      WHERE workspace_id = ${ws} AND rung = 3`;
    for (const r of kept) {
      const d = (typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail) as Partial<OptionDetail> & { rulesOnly?: boolean };
      const k = gapKey(String(r.responsibility_id), String(r.check_key));
      if (d.rulesOnly === true) existingRulesOnly.add(k);
      if (!d.sources?.includes("model") || !d.value || !d.evidence?.length) continue;
      existingModel.set(k, [...(existingModel.get(k) ?? []), { value: d.value, source: "model", evidence: d.evidence, why: d.why }]);
    }
  }

  const perGap = await mapLimit(gaps, MODEL_CONCURRENCY, async ({ q, resp, check }) => {
    const out: StepRow[] = [];
    const gk = gapKey(resp.id, check.key);
    const open_ = openRoles(resp, check, roles, meta);
    const label = entityLabel(resp.entities[0] ?? "", pack) || resp.title;
    const base = { responsibility_id: resp.id, check_key: check.key };
    const failed = (rung: number, err: unknown): StepRow => row({
      ...base, rung, kind: "none", status: "none", target: "none", role_set: open_,
      reason: `Could not run: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`, detail: { failed: true },
    });

    // rung 1: people
    try {
      const topic = new Set(resp.entities.flatMap((e) => [...(index.get(e) ?? [])]));
      let scores: NeighbourScore[] = neighbourScores(graph, topic, { leaverIds }).slice(0, 12);
      // A role holder is scored only on what their own role may see, so the row and its reason are
      // safe to show them. If nothing they may see puts them near the topic, they are not a candidate.
      scores = scores.flatMap((s) => {
        const held = (nodeRoles.get(s.personId) ?? []).filter((r) => r !== leaverRole);
        if (held.length === 0 || held.some((r) => s.roleSet.includes(r))) return [s];
        const g = graphFor(held[0]);
        const visibleTopic = new Set([...topic].filter((id) => g.byId.has(id)));
        const again = neighbourScores(g, visibleTopic, { leaverIds }).find((x) => x.personId === s.personId);
        return again ? [again] : [];
      }).sort((a, b) => b.score - a.score || byNumericId(a.personId, b.personId));
      const plans: NeighbourPlan[] = routeCandidates(scores, { byPerson: nodeRoles }, resp, check, meta, leaverRole, (id) => displayName.get(id) ?? id);
      let position = 0;
      for (const p of plans) {
        const roleSet = neighbourRowRoleSet(p.roleSet, open_);
        if (p.status === "asked" && (!p.role || !roleSet.includes(p.role))) continue; // cannot be shown to the person asked
        const questionText = p.status === "asked" && p.role
          ? neighbourQuestionText({ gapType: q.gapType, claimIds: q.claimIds }, resp, check, resp.kind, await visibleFor(p.role), p.role, ctx.leaver)
          : null;
        out.push(row({
          ...base, rung: 1, kind: "neighbour", status: p.status, target: p.personId, position: position++,
          target_person: p.personId, target_role: p.role, score: p.score, reason: neighbourReason(p.counts, label),
          question_text: questionText, detail: { counts: p.counts }, role_set: roleSet,
        }));
      }
      if (out.length === 0) out.push(row({ ...base, rung: 1, kind: "none", status: "none", target: "none", role_set: open_ }));
    } catch (err) {
      out.push(failed(1, err));
    }

    // rung 2: files and history
    try {
      if (traceError) throw new Error(traceError);
      if (check.wTag === "WHO") {
        out.push(row({ ...base, rung: 2, kind: "none", status: "not_applicable", target: "none", role_set: open_, detail: { why: "who" } }));
      } else {
        const related = stored.filter((t) => resp.entities.includes(t.claim.entity));
        const serving = related.filter((t) => t.claim.roleSet.length > 0 && traceServes(t.claim, resp, check, t.claim.roleSet[0], now));
        let position = 0;
        for (const t of serving) {
          out.push(row({
            ...base, rung: 2, kind: "trace", status: "found", target: t.trace.id, position: position++, target_ref: t.trace.id,
            claim_id: t.claim.id, role_set: t.claim.roleSet.filter((r) => open_.includes(r)),
            detail: { title: t.trace.title, traceKind: t.trace.kind, quoted: t.quoted, total: t.total },
          }));
        }
        if (serving.length === 0) {
          out.push(row({ ...base, rung: 2, kind: "none", status: "none", target: "none", role_set: open_, detail: { related: related.length > 0 } }));
        }
      }
    } catch (err) {
      out.push(failed(2, err));
    }

    // rung 3: possible answers
    try {
      if (coverageOf.get(gk) === "covered") {
        out.push(row({ ...base, rung: 3, kind: "none", status: "not_applicable", target: "none", role_set: open_, detail: { why: "closed" } }));
      } else {
        const onGap = allClaims.filter((c) => resp.entities.includes(c.entity));
        const candidates: OptionCandidate[] = [
          ...conflictOptions(resp, check, onGap),
          ...weakOptions(resp, check, onGap, now),
          ...patternOptions(resp, check, stored.map((t) => ({ entityKey: t.claim.entity, impliedNext: t.trace.impliedNext, claim: t.claim }))),
        ];
        let rulesOnly = false;
        const distinct = new Set(candidates.map((c) => c.value.trim().toLowerCase())).size;
        if (!wantModel) {
          candidates.push(...(existingModel.get(gk) ?? []));
          rulesOnly = existingRulesOnly.has(gk);
        } else if (distinct < 2) {
          const record = onGap.filter((c) => isRecordOrigin(c.origin) && (c.state === "active" || c.state === "conflicting"));
          if (modelOff) {
            rulesOnly = record.length > 0;
          } else if (record.length > 0) {
            const proposed = await proposeOptions(ctx, resp, check, q.text, record, !modelUp);
            candidates.push(...proposed.candidates);
            rulesOnly = proposed.unavailable;
          }
        }
        const ranked = rankOptions(candidates, (a, k) => authority(a, k, pack), now, roles);
        ranked.forEach((o, i) => {
          const detail: OptionDetail & { single: boolean; rulesOnly: boolean } = {
            value: o.value, sources: o.sources, ...(o.why ? { why: o.why } : {}), single: ranked.length === 1, rulesOnly,
            evidence: o.evidence.map((e) => ({ ...e, sourceName: e.segmentId ? sourceNames.get(segSource.get(e.segmentId) ?? "") ?? null : null })),
          };
          out.push(row({
            ...base, rung: 3, kind: "option", status: "offered", target: sha256Hex(o.value.trim().toLowerCase()).slice(0, 12), position: i,
            target_ref: sha256Hex(o.value.trim().toLowerCase()).slice(0, 12), score: o.score,
            role_set: o.roleSet.filter((r) => open_.includes(r)), detail: detail as unknown as Record<string, unknown>,
          }));
        });
        if (ranked.length === 0) {
          out.push(row({ ...base, rung: 3, kind: "none", status: "none", target: "none", role_set: open_, detail: { rulesOnly } }));
        }
      }
    } catch (err) {
      out.push(failed(3, err));
    }
    return out;
  });
  rows.push(...perGap.flat());

  // ---- write: upsert, keep what people already answered, drop what is stale.
  const ids = rows.map((r) => r.id);
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM recovery_steps WHERE workspace_id = ${ws} AND NOT (id = ANY(${ids}::text[]))
        AND status NOT IN ('answered', 'declined')`;
    for (const r of rows) {
      await tx`
        INSERT INTO recovery_steps (workspace_id, id, responsibility_id, check_key, rung, kind, position, target_person, target_role,
          target_ref, status, score, reason, question_text, detail, claim_id, role_set)
        VALUES (${ws}, ${r.id}, ${r.responsibility_id}, ${r.check_key}, ${r.rung}, ${r.kind}, ${r.position}, ${r.target_person},
          ${r.target_role}, ${r.target_ref}, ${r.status}, ${r.score}, ${r.reason}, ${r.question_text},
          ${JSON.stringify(r.detail)}::jsonb, ${r.claim_id}, ${r.role_set}::text[])
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          position = EXCLUDED.position, target_role = EXCLUDED.target_role, target_ref = EXCLUDED.target_ref,
          status = EXCLUDED.status, score = EXCLUDED.score, reason = EXCLUDED.reason, question_text = EXCLUDED.question_text,
          detail = EXCLUDED.detail, claim_id = EXCLUDED.claim_id, role_set = EXCLUDED.role_set, kind = EXCLUDED.kind,
          updated_at = now()
        WHERE recovery_steps.status NOT IN ('answered', 'declined')`;
    }
  });

  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (r.responsibility_id === LIBRARY) continue;
    const k = `rung${r.rung}_${r.status}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  counts.traces = stored.length;
  await audit(ws, "system", "recovery_ladder_built", { gaps: gaps.length, steps: rows.length, counts, model: wantModel ? (modelUp ? "live" : "cache") : "kept" });
  return { gaps: gaps.length, steps: rows.length, counts };
}

// ---------------------------------------------------------------------------
// Ladder: read (always under RLS as the viewing role)
// ---------------------------------------------------------------------------

export interface LadderStep {
  id: string;
  rung: 1 | 2 | 3;
  kind: "neighbour" | "trace" | "option" | "none";
  position: number;
  status: string;
  targetPerson: string | null;
  targetRole: RoleKey | null;
  targetRef: string | null;
  personName: string | null;
  reason: string;
  questionText: string | null;
  detail: Record<string, unknown>;
  claimId: string | null;
  /** For an answered neighbour row: the statement of the Second-hand claim, when this role may read it. */
  statement: string | null;
}

export interface LadderGap {
  questionId: string;
  rank: number;
  responsibilityId: string;
  responsibilityKey: string;
  responsibilityTitle: string;
  checkKey: string;
  checkLabel: string;
  gapType: QuestionView["gapType"];
  weight: number | null;
  urgency: number | null;
  score: number;
  text: string;
  state: GapState;
  coverage: Coverage | null;
  /** The check takes a deadline and the record disagrees: plan for the earlier date. */
  earlierDateHint: boolean;
  rungs: { 1: LadderStep[]; 2: LadderStep[]; 3: LadderStep[] };
}

function toStep(r: Record<string, unknown>, names: Record<string, string>): LadderStep {
  const person = (r.target_person as string | null) ?? null;
  return {
    id: String(r.id),
    rung: Number(r.rung) as 1 | 2 | 3,
    kind: r.kind as LadderStep["kind"],
    position: Number(r.position ?? 0),
    status: String(r.status),
    targetPerson: person,
    targetRole: (r.target_role as RoleKey | null) ?? null,
    targetRef: (r.target_ref as string | null) ?? null,
    personName: person ? names[person] ?? null : null,
    reason: String(r.reason ?? ""),
    questionText: (r.question_text as string | null) ?? null,
    detail: (typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail ?? {}) as Record<string, unknown>,
    claimId: (r.claim_id as string | null) ?? null,
    statement: (r.statement as string | null) ?? null,
  };
}

/** Recovery step rows `role` may read, with the statement of any claim they point to (both under RLS). */
async function readSteps(ws: string, role: RoleKey): Promise<Record<string, unknown>[]> {
  return withRole(ws, role, (tx) => tx`
    SELECT s.*, c.statement AS statement
    FROM recovery_steps s
    LEFT JOIN claims c ON c.workspace_id = s.workspace_id AND c.id = s.claim_id AND c.state <> 'dropped'
    WHERE s.workspace_id = ${ws}
    ORDER BY s.responsibility_id, s.check_key, s.rung, s.position, s.id`);
}

async function peopleNamesFor(ws: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of await listPeople(ws)) out[p.id] = p.displayName;
  return out;
}

/**
 * The ladder as `role` sees it: one entry per open gap question, with only the step rows RLS lets
 * that role read. A role with no readable row in a rung cannot tell hidden rows from none.
 */
export async function listLadder(ws: string, role: RoleKey): Promise<LadderGap[]> {
  const pack = await getWorkspacePack(ws);
  const lpack = toLacunaPack(pack);
  const [questions, resps, rowsRaw, names, latest] = await Promise.all([
    listQuestions(ws), listResponsibilities(ws), readSteps(ws, role), peopleNamesFor(ws),
    getLatestTestRun(ws, pack.successorRole as RoleKey),
  ]);
  const respById = new Map(resps.map((r) => [r.id, r]));
  const coverage = new Map((latest?.results ?? []).map((r) => [gapKey(r.responsibilityId, r.checkKey), r.coverage]));
  const steps = rowsRaw.map((r) => ({ key: gapKey(String(r.responsibility_id), String(r.check_key)), step: toStep(r, names) }));
  const fullText = role === pack.leaverRole || role === pack.approverRole || role === pack.successorRole;
  const out: LadderGap[] = [];
  for (const q of questions.filter((x) => !x.answeredClaimId)) {
    const resp = respById.get(q.responsibilityId);
    const check = resp ? checksFor(resp, lpack).find((c) => c.key === q.checkKey) : undefined;
    if (!resp || !check) continue;
    const mine = steps.filter((s) => s.key === gapKey(q.responsibilityId, q.checkKey)).map((s) => s.step);
    const cov = coverage.get(gapKey(q.responsibilityId, q.checkKey)) ?? null;
    // Other roles get a conflicting question without the quoted values (as on the normal Ask page).
    const text = fullText || q.gapType !== "conflicting"
      ? q.text
      : neighbourQuestionText({ gapType: "conflicting", claimIds: [] }, resp, check, resp.kind, [], role, leaverName(pack));
    out.push({
      questionId: q.id, rank: q.rank, responsibilityId: resp.id, responsibilityKey: resp.key, responsibilityTitle: resp.title,
      checkKey: check.key, checkLabel: check.label, gapType: q.gapType, weight: q.weight, urgency: q.urgency, score: q.score, text,
      state: gapState(cov ?? undefined), coverage: cov,
      earlierDateHint: q.gapType === "conflicting" && check.attributes.includes("deadline"),
      rungs: {
        1: mine.filter((s) => s.rung === 1), 2: mine.filter((s) => s.rung === 2), 3: mine.filter((s) => s.rung === 3),
      },
    });
  }
  return out;
}

export interface NeighbourQuestion {
  stepId: string;
  personId: string;
  personName: string;
  responsibilityKey: string;
  responsibilityTitle: string;
  checkLabel: string;
  text: string;
  reason: string;
  /** Roles the answer starts with; the neighbour may untick any that is not in `keep`. */
  defaultRoles: RoleKey[];
  keep: RoleKey[];
  sample: string | null;
}

/** Questions waiting for `role`: asked steps whose target role is the viewing role (read under RLS). */
export async function questionsForRole(ws: string, role: RoleKey): Promise<NeighbourQuestion[]> {
  const state = await recoveryState(ws);
  if (!state.on) return [];
  const pack = await getWorkspacePack(ws);
  const lpack = toLacunaPack(pack);
  const rows = await withRole(ws, role, (tx) => tx`
    SELECT * FROM recovery_steps WHERE workspace_id = ${ws} AND rung = 1 AND kind = 'neighbour'
      AND status = 'asked' AND target_role = ${role}
    ORDER BY responsibility_id, check_key, position, id`);
  if (rows.length === 0) return [];
  const [resps, names, visible, samples, questions] = await Promise.all([
    listResponsibilities(ws), peopleNamesFor(ws), visibleClaims(ws, role), recoverySamples(ws), listQuestions(ws),
  ]);
  const respById = new Map(resps.map((r) => [r.id, r]));
  const rank = new Map(questions.map((q) => [gapKey(q.responsibilityId, q.checkKey), q.rank]));
  const base = pack.uploadDefaults.roleSet as RoleKey[];
  const keep = [...new Set([role, pack.approverRole as RoleKey])];
  const out: (NeighbourQuestion & { rank: number })[] = [];
  for (const r of rows) {
    const resp = respById.get(String(r.responsibility_id));
    const check = resp ? checksFor(resp, lpack).find((c) => c.key === String(r.check_key)) : undefined;
    if (!resp || !check) continue;
    const personId = String(r.target_person ?? "");
    const personName = names[personId] ?? "A colleague";
    const sample = samples.answers.find((s) => resp.entities.includes(s.entity) && s.checkKey === check.key && nameKey(s.person) === nameKey(personName));
    out.push({
      stepId: String(r.id), personId, personName, responsibilityKey: resp.key, responsibilityTitle: resp.title, checkLabel: check.label,
      text: String(r.question_text ?? ""), reason: String(r.reason ?? ""),
      defaultRoles: defaultAnswerRoleSet(base, resp, check, visible, keep), keep, sample: sample?.text ?? null,
      rank: rank.get(gapKey(resp.id, check.key)) ?? 999,
    });
  }
  out.sort((a, b) => a.rank - b.rank || byNumericId(a.personId, b.personId));
  return out.map((q): NeighbourQuestion => ({
    stepId: q.stepId, personId: q.personId, personName: q.personName, responsibilityKey: q.responsibilityKey,
    responsibilityTitle: q.responsibilityTitle, checkLabel: q.checkLabel, text: q.text, reason: q.reason,
    defaultRoles: q.defaultRoles, keep: q.keep, sample: q.sample,
  }));
}

export interface NeighbourReply {
  stepId: string;
  personName: string;
  responsibilityKey: string;
  responsibilityTitle: string;
  checkLabel: string;
  text: string;
  status: "answered" | "declined";
  /** The re-test sentence stored with an answer, e.g. "B 7 (no change) · C 61% → 63% · K 91% → 88%". */
  scoreDelta: string | null;
  statement: string | null;
}

/** What `role` already answered or declined (read under RLS), so the page can confirm it after a refresh. */
export async function repliesByRole(ws: string, role: RoleKey): Promise<NeighbourReply[]> {
  if (!(await recoveryState(ws)).on) return [];
  const pack = await getWorkspacePack(ws);
  const lpack = toLacunaPack(pack);
  const rows = await withRole(ws, role, (tx) => tx`
    SELECT s.*, c.statement AS statement
    FROM recovery_steps s
    LEFT JOIN claims c ON c.workspace_id = s.workspace_id AND c.id = s.claim_id AND c.state <> 'dropped'
    WHERE s.workspace_id = ${ws} AND s.rung = 1 AND s.kind = 'neighbour' AND s.target_role = ${role}
      AND s.status IN ('answered', 'declined')
    ORDER BY s.updated_at DESC, s.id`);
  if (rows.length === 0) return [];
  const [resps, names] = await Promise.all([listResponsibilities(ws), peopleNamesFor(ws)]);
  const out: NeighbourReply[] = [];
  for (const r of rows) {
    const resp = resps.find((x) => x.id === String(r.responsibility_id));
    const check = resp ? checksFor(resp, lpack).find((c) => c.key === String(r.check_key)) : undefined;
    if (!resp || !check) continue;
    const d = (typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail ?? {}) as { scoreDelta?: string };
    out.push({
      stepId: String(r.id), personName: names[String(r.target_person ?? "")] ?? "A colleague", responsibilityKey: resp.key,
      responsibilityTitle: resp.title, checkLabel: check.label, text: String(r.question_text ?? ""),
      status: r.status === "answered" ? "answered" : "declined", scoreDelta: d.scoreDelta ?? null,
      statement: (r.statement as string | null) ?? null,
    });
  }
  return out;
}

/** Roles that are the target of at least one asked step (the only roles "Switch to ... to answer" accepts). */
export async function askedRoles(ws: string): Promise<RoleKey[]> {
  const rows = await db()`
    SELECT DISTINCT target_role FROM recovery_steps
    WHERE workspace_id = ${ws} AND rung = 1 AND status = 'asked' AND target_role IS NOT NULL`;
  return rows.map((r) => String(r.target_role));
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export type NeighbourAnswerResult =
  | { ok: true; declined: false; claimId: string; delta: string; before: Scores | null; after: Scores }
  | { ok: true; declined: true }
  | { ok: false; error: string };

async function loadStep(sql: Sql, ws: string, id: string): Promise<Record<string, unknown> | null> {
  const [r] = await sql`SELECT * FROM recovery_steps WHERE workspace_id = ${ws} AND id = ${id} AND rung = 1 AND kind = 'neighbour'`;
  return r ?? null;
}

async function checkStep(
  ws: string, stepIdValue: string, actor: RoleKey,
): Promise<{ ok: true; step: Record<string, unknown>; pack: ResolvedPack } | { ok: false; error: string }> {
  const pack = await getWorkspacePack(ws);
  const n = names(pack);
  if (!(await recoveryState(ws)).on) return { ok: false, error: `Recovery is off. ${n.leaver} answers these now.` };
  const step = await loadStep(db(), ws, stepIdValue);
  if (!step) return { ok: false, error: "Question not found." };
  if (String(step.target_role ?? "") !== actor) return { ok: false, error: "Only the person who was asked can answer this." };
  if (step.status === "answered" || step.status === "declined") return { ok: false, error: "You already answered this." };
  if (step.status !== "asked") return { ok: false, error: "Only the person who was asked can answer this." };
  return { ok: true, step, pack };
}

/**
 * A neighbour answers a gap. Only the role that was asked may answer, and only while recovery is
 * on. The answer is masked, stored as an answer segment in the "Recovery answers" source and as a
 * Second-hand claim whose role set starts from the records on the topic the neighbour can see and
 * may only be narrowed. The gap question stays open for the leaver: answered_claim_id is not
 * touched. A typed non-answer ("I don't know") is a decline and stores no evidence.
 */
export async function answerAsNeighbour(
  ws: string, stepIdValue: string, answer: string, actor: RoleKey, opts: { narrowRoles?: RoleKey[] } = {},
): Promise<NeighbourAnswerResult> {
  const sql = db();
  const checked = await checkStep(ws, stepIdValue, actor);
  if (!checked.ok) return checked;
  const { step, pack } = checked;
  const text = (answer ?? "").trim();
  if (text.length < 2) return { ok: false, error: "Write an answer first." };
  if (text.length > 4000) return { ok: false, error: "Keep the answer under 4000 characters." };
  if (looksLikeNoAnswer(text)) return declineAsNeighbour(ws, stepIdValue, actor);

  const lpack = toLacunaPack(pack);
  const successor = pack.successorRole as RoleKey;
  const [rRow] = await sql`SELECT * FROM responsibilities WHERE workspace_id = ${ws} AND id = ${String(step.responsibility_id)}`;
  const resps = await listResponsibilities(ws);
  const resp = resps.find((r) => r.id === String(step.responsibility_id));
  if (!rRow || !resp) return { ok: false, error: "Responsibility not found." };
  const check = checksFor(resp, lpack).find((c) => c.key === String(step.check_key));
  if (!check) return { ok: false, error: "Check not found in the setting pack." };

  // Role set: the pack default, cut down to the roles that already see the records on this topic
  // that the neighbour can see, then narrowed by the neighbour. Their own role and the approver stay.
  const base = pack.uploadDefaults.roleSet as RoleKey[];
  const keep = [...new Set([actor, pack.approverRole as RoleKey])];
  const start = defaultAnswerRoleSet(base, resp, check, await visibleClaims(ws, actor), keep);
  const roleSet = narrowAnswerRoleSet(start, opts.narrowRoles, keep);
  // SENSITIVITY HOOK: the answer's role set is final here. The confidentiality classifier can
  // narrow `roleSet` further (never widen it) before the segment and claim are stored.

  const masked = await maskAnswer(ws, text);
  const personId = (step.target_person as string | null) ?? null;
  const personName = personId ? (await peopleNamesFor(ws))[personId] ?? "A colleague" : "A colleague";
  // A demo workspace lives on the fixed day of its story, so the same answer gives the same
  // segment and claim ids in every copy (and the re-test replays from the cache).
  const w = await getWorkspace(ws);
  const answeredAt = new Date().toISOString();
  const ts = w?.kind === "demo" ? new Date(await workspaceNow(ws)).toISOString() : answeredAt;
  const { segment, claim: draft } = neighbourAnswerToDrafts(
    masked.text,
    { id: String(step.id), text: String(step.question_text ?? ""), resp, check, roleSet, entityLabel: entityLabel(resp.entities[0] ?? "", pack) || resp.title },
    { id: personId, name: personName },
    { ts, sourceId: RECOVERY_SOURCE, workspaceId: ws },
  );
  segment.meta = { ...segment.meta, answeredAt, stepId: String(step.id) };
  const id = makeClaimId(draft.entity, draft.attribute, draft.value, [segment.id]);
  const claim: Claim = {
    id, workspaceId: ws, entity: draft.entity, entityLabel: draft.entityLabel, attribute: draft.attribute,
    value: draft.value.slice(0, 1000), statement: draft.statement, citations: draft.citations, trust: "second_hand",
    state: "active", stateNote: null, supersededBy: null, roleSet: draft.roleSet, validFrom: ts, authorId: personId,
    sourceKinds: ["interview"], importance: check.weight === 5 ? "blocking" : check.weight === 3 ? "important" : "normal",
    tier: "B", review: "pending", reviewNote: null, origin: "neighbour_answer", supportCheck: null,
  };
  claim.tier = tierFor(claim, pack);

  const before = await getLatestTestRun(ws, successor);
  let won = false;
  await sql.begin(async (tx) => {
    // The status change is the lock: a double submit finds the row already answered and stores nothing.
    const locked = await tx`
      UPDATE recovery_steps SET status = 'answered', claim_id = ${claim.id}, updated_at = now()
      WHERE workspace_id = ${ws} AND id = ${String(step.id)} AND status = 'asked' RETURNING id`;
    if (locked.length === 0) return;
    won = true;
    await persistAnswer(tx, ws, {
      source: { id: RECOVERY_SOURCE, name: RECOVERY_SOURCE_NAME, roleSet: base },
      segment,
      claim,
      masked,
      contactRoles: (pack.contactsRoles as RoleKey[]).filter((r) => claim.roleSet.includes(r)),
      event: {
        origin: "neighbour_answer", stepId: String(step.id), segmentId: segment.id, trust: "second_hand", roleSet: claim.roleSet,
        narrowed: claim.roleSet.length < start.length,
      },
      actor,
    });
  });
  if (!won) return { ok: false, error: "You already answered this." };
  await audit(ws, actor, "neighbour_answer", { stepId: String(step.id), claimId: claim.id, roleSet: claim.roleSet });

  // Re-test only the answered responsibility, as the successor and as every other role the pack tests.
  const trigger = `recovery answer ${String(step.id)}`;
  const [after] = await Promise.all(pack.testRoles.map((role) => runTest(ws, role, { trigger, only: [resp.id] })));
  const checks = checksByResp(resps, lpack);
  const delta = before ? scoreDelta(before, after, checks) : `B ${after.scores.b} · C ${Math.round(after.scores.c * 100)}%`;
  // The re-test sentence is kept with the step, so the page can show it again after a refresh.
  const priorDetail = (typeof step.detail === "string" ? JSON.parse(step.detail) : step.detail ?? {}) as Record<string, unknown>;
  await sql`UPDATE recovery_steps SET detail = ${JSON.stringify({ ...priorDetail, answeredAt, scoreDelta: delta })}::jsonb
    WHERE workspace_id = ${ws} AND id = ${String(step.id)}`;
  // Rule-based options for the gaps are refreshed; model proposals are kept as they were.
  try {
    await buildLadder(ws, { model: false });
  } catch (err) {
    console.error(`[recovery ${ws}] ladder refresh after an answer failed`, err);
  }
  return { ok: true, declined: false, claimId: claim.id, delta, before: before?.scores ?? null, after: after.scores };
}

/** "I don't know": the step is closed, nothing is stored as evidence, and no score moves. */
export async function declineAsNeighbour(ws: string, stepIdValue: string, actor: RoleKey): Promise<NeighbourAnswerResult> {
  const checked = await checkStep(ws, stepIdValue, actor);
  if (!checked.ok) return checked;
  const changed = await db()`
    UPDATE recovery_steps SET status = 'declined', updated_at = now()
    WHERE workspace_id = ${ws} AND id = ${stepIdValue} AND status = 'asked' RETURNING id`;
  if (changed.length === 0) return { ok: false, error: "You already answered this." };
  await audit(ws, actor, "neighbour_declined", { stepId: stepIdValue });
  return { ok: true, declined: true };
}

// ---------------------------------------------------------------------------
// Before and after
// ---------------------------------------------------------------------------

export interface RecoveryComparison {
  /** Column 1: if the leaver answered. */
  withLeaver: { summary: LadderSummary; scores: Scores; mix: Partial<Record<Trust, number>>; source: "stored_run" | "projection" };
  /** Column 2: without the leaver, from the latest successor test. */
  without: { summary: LadderSummary; scores: Scores; mix: Partial<Record<Trust, number>> };
  baseline: Scores | null;
}

async function runById(ws: string, id: string | null): Promise<TestRun | null> {
  if (!id) return null;
  const [r] = await db()`SELECT * FROM test_runs WHERE workspace_id = ${ws} AND id = ${id}`;
  if (!r) return null;
  return {
    id: String(r.id), workspaceId: ws, role: String(r.role), createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    scores: (typeof r.scores === "string" ? JSON.parse(r.scores) : r.scores) as Scores,
    results: (typeof r.results === "string" ? JSON.parse(r.results) : r.results) as CheckResult[],
    provisional: Boolean(r.provisional), modelUsed: Boolean(r.model_used),
  };
}

/** The gaps the ladder works: every gap that has a recovery step row (admin read of keys only). */
async function ladderGapKeys(ws: string): Promise<Set<string>> {
  const rows = await db()`
    SELECT DISTINCT responsibility_id, check_key FROM recovery_steps
    WHERE workspace_id = ${ws} AND responsibility_id <> ${LIBRARY}`;
  return new Set(rows.map((r) => gapKey(String(r.responsibility_id), String(r.check_key))));
}

/**
 * The before and after panel. Column 1 is a real stored run of the precomputed demo in which the
 * leaver answered (when the demo data carries one and this workspace's baseline matches it),
 * otherwise the scoring rules applied to the baseline: an upper bound, no model. Column 2 is the
 * latest successor test. Scores and counts only: nothing here is role-restricted content.
 */
export async function recoveryComparison(ws: string): Promise<RecoveryComparison | null> {
  const pack = await getWorkspacePack(ws);
  const lpack = toLacunaPack(pack);
  const successor = pack.successorRole as RoleKey;
  const state = await recoveryState(ws);
  const [latest, resps, plan, keys] = await Promise.all([
    getLatestTestRun(ws, successor), listResponsibilities(ws), listPlanItems(ws), ladderGapKeys(ws),
  ]);
  if (!latest) return null;
  const baseline = (await runById(ws, state.baselineRunId)) ?? latest;
  const checks = checksByResp(resps, lpack);
  const named = namedOwnersFromPlan(openBlockingGaps(baseline.results, checks), plan);
  const projected = projectLeaverRun(baseline, keys, checks, named);
  let withLeaver: RecoveryComparison["withLeaver"] = {
    summary: ladderSummary(keys, projected.results), scores: projected.scores, mix: evidenceMix(projected.results, checks), source: "projection",
  };
  const stored = (await recoverySamples(ws)).withLeaver;
  if (stored && stored.baseline && sameScores(stored.baseline, baseline.scores) && stored.worked === keys.size) {
    withLeaver = {
      summary: { worked: stored.worked, closed: stored.closed, partly: stored.partly, open: stored.open },
      scores: stored.scores, mix: stored.mix ?? {}, source: "stored_run",
    };
  }
  return {
    withLeaver,
    without: { summary: ladderSummary(keys, latest.results), scores: latest.scores, mix: evidenceMix(latest.results, checks) },
    baseline: baseline.scores,
  };
}

function sameScores(a: Scores, b: Scores): boolean {
  const near = (x: number | null, y: number | null) => (x === null || y === null ? x === y : Math.abs(x - y) < 0.005);
  return a.b === b.b && near(a.c, b.c) && near(a.k, b.k);
}

// ---------------------------------------------------------------------------
// Rebuilt procedures
// ---------------------------------------------------------------------------

export interface TraceView {
  claimId: string;
  traceId: string;
  title: string;
  traceKind: TraceKind;
  statement: string;
  entity: string;
  entityLabel: string;
  steps: TraceStepView[];
  quoted: number;
  total: number;
  /** Open gaps this trace helps with (that this role may see it on). */
  helps: { responsibilityKey: string; checkLabel: string }[];
}

/** Every trace claim `role` may see, with its steps. Claims and step rows are both read under RLS. */
export async function listTraces(ws: string, role: RoleKey): Promise<TraceView[]> {
  const pack = await getWorkspacePack(ws);
  const lpack = toLacunaPack(pack);
  const [rows, resps] = await Promise.all([
    withRole(ws, role, (tx) => tx`
      SELECT s.responsibility_id, s.check_key, s.target_ref, s.detail, c.id AS claim_id, c.statement, c.entity, c.entity_label
      FROM recovery_steps s
      JOIN claims c ON c.workspace_id = s.workspace_id AND c.id = s.claim_id AND c.origin = 'trace' AND c.state = 'active'
      WHERE s.workspace_id = ${ws} AND s.rung = 2 AND s.kind = 'trace'
      ORDER BY c.entity, s.target_ref`),
    listResponsibilities(ws),
  ]);
  const respById = new Map(resps.map((r) => [r.id, r]));
  const out = new Map<string, TraceView>();
  for (const r of rows) {
    if (String(r.responsibility_id) !== LIBRARY) continue;
    const d = (typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail) as Record<string, unknown>;
    out.set(String(r.target_ref), {
      claimId: String(r.claim_id), traceId: String(r.target_ref), title: String(d.title ?? "Rebuilt procedure"),
      traceKind: String(d.traceKind ?? "workflow") as TraceKind, statement: String(r.statement), entity: String(r.entity),
      entityLabel: String(r.entity_label), steps: (d.steps as TraceStepView[]) ?? [], quoted: Number(d.quoted ?? 0), total: Number(d.total ?? 0),
      helps: [],
    });
  }
  for (const r of rows) {
    if (String(r.responsibility_id) === LIBRARY) continue;
    const view = out.get(String(r.target_ref));
    const resp = respById.get(String(r.responsibility_id));
    const check = resp ? checksFor(resp, lpack).find((c) => c.key === String(r.check_key)) : undefined;
    if (view && resp && check) view.helps.push({ responsibilityKey: resp.key, checkLabel: check.label });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Leak grid hand-off
// ---------------------------------------------------------------------------

/**
 * Everything `role` can read from recovery, as plain text, for the leak grid: neighbour names and
 * reasons, the questions waiting for this role, traces and options. Built only from the same
 * role-scoped reads the Ask page uses.
 */
export async function recoverySurfaces(ws: string, role: RoleKey): Promise<{ surface: string; text: string }[]> {
  const out: { surface: string; text: string }[] = [];
  if (!(await recoveryState(ws)).on) return out;
  const ladder = await listLadder(ws, role);
  const neighbours: string[] = [];
  const options: string[] = [];
  const rung2: string[] = [];
  for (const g of ladder) {
    for (const s of g.rungs[1]) {
      if (s.kind !== "neighbour") continue;
      neighbours.push([g.responsibilityKey, g.checkLabel, s.personName ?? "", s.status === "skipped_no_access" ? "Skipped: no access" : s.status, s.reason, s.statement ?? ""].join(" | "));
    }
    for (const s of g.rungs[2]) {
      if (s.kind === "trace") rung2.push([g.responsibilityKey, g.checkLabel, String(s.detail.title ?? ""), s.statement ?? ""].join(" | "));
    }
    for (const s of g.rungs[3]) {
      if (s.kind !== "option") continue;
      const d = s.detail as unknown as OptionDetail;
      options.push([g.responsibilityKey, g.checkLabel, d.value, d.why ?? "", ...(d.evidence ?? []).map((e) => `${e.sourceName ?? ""} ${e.quote ?? ""}`)].join(" | "));
    }
  }
  const questions = (await questionsForRole(ws, role)).map((q) => `${q.responsibilityKey} | ${q.checkLabel} | ${q.personName} | ${q.text} | ${q.reason}`);
  const traces = (await listTraces(ws, role)).map((t) => [t.title, t.statement, ...t.steps.map((s) => `${s.text} ${s.quote ?? ""}`)].join(" | "));
  out.push({ surface: "recovery neighbours", text: neighbours.join("\n") });
  out.push({ surface: "recovery questions for this role", text: questions.join("\n") });
  out.push({ surface: "recovery traces", text: [...rung2, ...traces].join("\n") });
  out.push({ surface: "recovery options", text: options.join("\n") });
  return out;
}

// ---------------------------------------------------------------------------
// Demo samples and precompute
// ---------------------------------------------------------------------------

export interface RecoverySample {
  entity: string;
  checkKey: string;
  person: string;
  text: string;
}

interface StoredLeaverRun {
  baseline: Scores;
  scores: Scores;
  worked: number;
  closed: number;
  partly: number;
  open: number;
  mix?: Partial<Record<Trust, number>>;
}

interface RecoveryDemoFile {
  sampleAnswers?: RecoverySample[];
  declineSample?: RecoverySample;
  leaverAnswers?: { entity: string; checkKey: string; text: string }[];
  withLeaver?: StoredLeaverRun | null;
}

const sampleCache = new Map<string, RecoveryDemoFile>();

/**
 * The demo's sample answers (<pack.demo.dataDir>/recovery.json), for demo workspaces only. They
 * let a judge finish the path without inventing an answer, and let the re-test replay from the cache.
 */
export async function recoverySamples(ws: string): Promise<{ answers: RecoverySample[]; decline: RecoverySample | null; leaverAnswers: { entity: string; checkKey: string; text: string }[]; withLeaver: StoredLeaverRun | null }> {
  const empty = { answers: [], decline: null, leaverAnswers: [], withLeaver: null };
  const w = await getWorkspace(ws);
  if (w?.kind !== "demo") return empty;
  const pack = await getWorkspacePack(ws);
  if (!pack.demo) return empty;
  let file = sampleCache.get(pack.id);
  if (!file) {
    try {
      // The demo folder ships through outputFileTracingIncludes (next.config.ts), not through tracing this call.
      const dir = path.resolve(/* turbopackIgnore: true */ process.cwd(), pack.demo.dataDir);
      file = JSON.parse(fs.readFileSync(path.join(dir, "recovery.json"), "utf8")) as RecoveryDemoFile;
    } catch {
      file = {};
    }
    sampleCache.set(pack.id, file);
  }
  return {
    answers: Array.isArray(file.sampleAnswers) ? file.sampleAnswers : [],
    decline: file.declineSample ?? null,
    leaverAnswers: Array.isArray(file.leaverAnswers) ? file.leaverAnswers : [],
    withLeaver: file.withLeaver ?? null,
  };
}

/**
 * Entry point for scripts/precompute.ts, after the pipeline run on a demo workspace: switch
 * recovery on and apply each sample answer once, so every model call of the judge path is
 * recorded in the cache. Idempotent.
 */
export async function precomputeRecovery(ws: string): Promise<{ gaps: number; answered: number; declined: number }> {
  const pack = await getWorkspacePack(ws);
  const res = await setLeaverUnreachable(ws, true, pack.approverRole as RoleKey, "Precompute");
  if (!res.ok) throw new Error(res.error);
  const samples = await recoverySamples(ws);
  const resps = await listResponsibilities(ws);
  const names = await peopleNamesFor(ws);
  let answered = 0;
  let declined = 0;
  const asked = await db()`
    SELECT id, responsibility_id, check_key, target_person, target_role FROM recovery_steps
    WHERE workspace_id = ${ws} AND rung = 1 AND status = 'asked' ORDER BY id`;
  for (const step of asked) {
    const resp = resps.find((r) => r.id === String(step.responsibility_id));
    const person = nameKey(names[String(step.target_person ?? "")] ?? "");
    if (!resp) continue;
    const match = (s: RecoverySample) => resp.entities.includes(s.entity) && s.checkKey === String(step.check_key) && nameKey(s.person) === person;
    const sample = samples.answers.find(match);
    if (sample) {
      const r = await answerAsNeighbour(ws, String(step.id), sample.text, String(step.target_role));
      if (r.ok && !r.declined) answered++;
    } else if (samples.decline && match(samples.decline)) {
      const r = await declineAsNeighbour(ws, String(step.id), String(step.target_role));
      if (r.ok) declined++;
    }
  }
  return { gaps: res.gaps, answered, declined };
}

/**
 * For the "with the leaver" column as a real stored run: on a scratch demo workspace (recovery
 * off), the leaver answers every open question with the demo's sample leaver answers, and the
 * result is returned in the shape recovery.json keeps under "withLeaver". Used by the precompute
 * step; never called from a page.
 */
export async function measureLeaverRun(ws: string): Promise<StoredLeaverRun | null> {
  const pack = await getWorkspacePack(ws);
  const lpack = toLacunaPack(pack);
  const successor = pack.successorRole as RoleKey;
  const samples = await recoverySamples(ws);
  const baseline = await getLatestTestRun(ws, successor);
  if (!baseline) return null;
  const resps = await listResponsibilities(ws);
  const open = (await listQuestions(ws)).filter((q) => !q.answeredClaimId);
  const keys = new Set(open.map((q) => gapKey(q.responsibilityId, q.checkKey)));
  for (const q of open) {
    const resp = resps.find((r) => r.id === q.responsibilityId);
    const sample = resp ? samples.leaverAnswers.find((s) => resp.entities.includes(s.entity) && s.checkKey === q.checkKey) : undefined;
    if (!sample) continue;
    await answerQuestion(ws, q.id, sample.text, pack.leaverRole as RoleKey);
  }
  const after = await getLatestTestRun(ws, successor);
  if (!after) return null;
  const checks = checksByResp(resps, lpack);
  return { baseline: baseline.scores, scores: after.scores, ...ladderSummary(keys, after.results), mix: evidenceMix(after.results, checks) };
}

export type { GapState, LadderSummary, NeighbourCounts };
