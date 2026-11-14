// Lacuna: Test and Ask (docs/ARCHITECTURE.md section 4). Database and model glue around the
// pure core in ./core. Public entry points (names and shapes used by the pipeline, pages and Relay):
//   buildInventory(ws)                                   -> { responsibilities, items, dropped }
//   confirmInventory(ws, actor)                          -> the approver confirms the inventory
//   runTest(ws, role, opts?)                             -> TestRun (stored; provisional until a snapshot)
//   buildQuestions(ws)                                   -> GapQuestion[] (top 10 open + answered)
//   answerQuestion(ws, qid, text, actor, narrowRoles?)   -> { ok, claimId, before, after, delta }
//   listBlockingGaps(ws, role?)                          -> BlockingGap[] (open blocking checks + plan)
//   savePlanItem(ws, item, actor)                        -> approver only
//   planComplete(p), releaseInfo(ws), scoreResults(results, weightOf)
import { db } from "@/lib/db/client";
import { toClaim, toGapQuestion, toResponsibility, toTestRun } from "@/lib/db/mappers";
import { sha256Hex } from "@/lib/text/norm";
import { audit, getLatestTestRun, getWorkspace, listPeople, listPlanItems, listResponsibilities, listSegments } from "@/lib/db/queries";
import { withRole } from "@/lib/db/withRole";
import { getWorkspacePack, entityLabel, roleLabel, type ResolvedPack } from "@/lib/pack";
import { claimId as makeClaimId, tierFor } from "@/lib/attest";
import { computeFootprint } from "@/lib/tether/footprint";
import { maskAnswer, persistAnswer } from "./persist";
import { callJson, modelAvailable } from "@/lib/model/client";
import type {
  CheckResult, Claim, Coverage, GapQuestion, Importance, PlanItem, Responsibility, RoleKey, Scores, TestRun, Trust,
} from "@/lib/types";
import { buildInventory as coreInventory } from "./core/inventory";
import { checksByResp, checksFor, findCheck } from "./core/checks";
import { RECORD_TRUST, gapKey, strongestTrust, type LacunaCheck, type LacunaPack } from "./core/pack";
import { computeScores, scoreDelta } from "./core/scores";
import {
  runStandin, STANDIN_JSON_SCHEMA, type ClaimMeta, type VisibleClaim,
} from "./core/standin";
import type { ModelCall } from "./core/model";
import { answerToDrafts, questionText, rankGaps } from "./core/questions";
import { namedOwnersFromPlan, openBlockingGaps, releaseState, type ReleaseState } from "./core/plan";
import { dropFinishedFootprint, leaverName, leaverPersonIds, markPartlyRestricted, mergeJudgements, toLacunaPack } from "./adapt";

export { toLacunaPack, leaverPersonIds, leaverName } from "./adapt";
export type { ReleaseState } from "./core/plan";
// Unreachable-leaver recovery (docs/ARCHITECTURE.md section 4, "Recovery").
export {
  recoveryState, setLeaverUnreachable, buildLadder, listLadder, questionsForRole, answerAsNeighbour, declineAsNeighbour,
  recoveryComparison, listTraces, recoverySurfaces, precomputeRecovery, measureLeaverRun, recoverySamples, askedRoles,
  repliesByRole,
} from "./recovery";
export type {
  RecoveryState, LadderGap, LadderStep, NeighbourQuestion, NeighbourReply, TraceView, RecoveryComparison, RecoverySample,
} from "./recovery";

const MODEL_CONCURRENCY = 6;

function lacunaPack(pack: ResolvedPack): LacunaPack {
  return toLacunaPack(pack);
}

/**
 * "Today" for inventory, urgency and recency. A demo workspace lives on the fixed day its pack's
 * demo story is written for (pack.demo.today); every other workspace uses the real time.
 */
export async function workspaceNow(ws: string): Promise<string> {
  const w = await getWorkspace(ws);
  if (w?.kind !== "demo") return new Date().toISOString();
  return (await getWorkspacePack(ws)).demo?.today ?? new Date().toISOString();
}

function importanceOf(weight: number): Importance {
  return weight === 5 ? "blocking" : weight === 3 ? "important" : "normal";
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface InventoryResult {
  responsibilities: number;
  items: Responsibility[];
  /** Footprint hits left out, with the reason (e.g. finished work only). */
  dropped: { entityKey: string; reason: string }[];
  leaverIds: string[];
}

/**
 * Build (or refresh) the responsibility inventory: task board + leaver footprint + role template,
 * merged by entity. Keeps `confirmed` for responsibilities that survive; removes stale ones.
 */
export async function buildInventory(ws: string): Promise<InventoryResult> {
  const sql = db();
  const pack = await getWorkspacePack(ws);
  const lpack = lacunaPack(pack);
  const now = await workspaceNow(ws);
  const [segments, people] = await Promise.all([listSegments(ws), listPeople(ws)]);
  // Tether's task cards carry taskId/updatedAt; core reads id/updated_at.
  const tasks = segments.filter((s) => s.kind === "task").map((t) => ({
    ...t,
    meta: { ...t.meta, id: t.meta.id ?? t.meta.taskId, updated_at: t.meta.updated_at ?? t.meta.updatedAt },
  }));
  const leaverIds = leaverPersonIds(people, leaverName(pack), pack.leaverPerson.aliases);
  const raw = leaverIds.length
    ? computeFootprint(segments, people, leaverIds, pack.footprint, pack.entities, { now })
    : [];
  const segById = new Map(segments.map((s) => [s.id, s]));
  const { kept, dropped } = dropFinishedFootprint(raw, tasks, segById, lpack, now);
  const items = coreInventory({
    workspaceId: ws, tasks, footprint: kept, pack: lpack, successorRole: pack.successorRole as RoleKey, today: now,
  });

  // A recurring duty found from a calendar schedule takes its next occurrence as due date, when
  // that calendar entry is visible to every role (the inventory is shown to all of them).
  const allRoles = pack.roles.map((r) => r.key as RoleKey);
  for (const item of items) {
    if (item.dueDate) continue;
    const next = kept
      .filter((c) => c.rule === "schedule" && item.entities.includes(c.entityKey))
      .flatMap((c) => c.evidenceSegmentIds)
      .map((id) => segById.get(id))
      .filter((sg): sg is NonNullable<typeof sg> => !!sg && sg.kind === "event" && allRoles.every((r) => sg.roleSet.includes(r)))
      .flatMap((sg) => [...((sg.meta.occurrences as string[] | undefined) ?? []), String(sg.meta.start ?? "")])
      .map((d) => d.slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= now.slice(0, 10))
      .sort()[0];
    if (next) item.dueDate = next;
  }

  const existing = new Map((await listResponsibilities(ws)).map((r) => [r.id, r]));
  await sql.begin(async (tx) => {
    const ids = items.map((r) => r.id);
    await tx`DELETE FROM responsibilities WHERE workspace_id = ${ws} AND NOT (id = ANY(${ids}::text[]))`;
    for (const r of items) {
      const prev = existing.get(r.id);
      const same = prev && prev.kind === r.kind && prev.title === r.title && prev.dueDate === r.dueDate
        && prev.entities.join(",") === r.entities.join(",");
      await tx`
        INSERT INTO responsibilities (workspace_id, id, key, title, kind, entities, origin, origin_detail, due_date, confirmed)
        VALUES (${ws}, ${r.id}, ${r.key}, ${r.title}, ${r.kind}, ${r.entities}::text[], ${r.origin}, ${r.originDetail},
          ${r.dueDate}::date, ${Boolean(same && prev?.confirmed)})
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          key = EXCLUDED.key, title = EXCLUDED.title, kind = EXCLUDED.kind, entities = EXCLUDED.entities,
          origin = EXCLUDED.origin, origin_detail = EXCLUDED.origin_detail, due_date = EXCLUDED.due_date,
          confirmed = EXCLUDED.confirmed`;
    }
  });
  return { responsibilities: items.length, items, dropped, leaverIds };
}

/** The approver confirms the inventory (logged). */
export async function confirmInventory(ws: string, actor: RoleKey): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const pack = await getWorkspacePack(ws);
  if (actor !== pack.approverRole) {
    return { ok: false, error: `Only the approver (${roleLabel(pack.approverRole, pack)}) can confirm the inventory.` };
  }
  const rows = await db()`
    UPDATE responsibilities SET confirmed = true, confirmed_at = now()
    WHERE workspace_id = ${ws} RETURNING key`;
  await audit(ws, actor, "confirm_inventory", { responsibilities: rows.map((r) => String(r.key)) });
  return { ok: true, count: rows.length };
}

// ---------------------------------------------------------------------------
// Successor test
// ---------------------------------------------------------------------------

/** Claim metadata for the Restricted decision (SECURITY DEFINER function; never statement or value). */
export async function claimMeta(ws: string, role?: RoleKey): Promise<Map<string, ClaimMeta>> {
  const rows = role
    ? await withRole(ws, role, (tx) => tx`SELECT * FROM claim_meta(${ws}::uuid)`)
    : await db()`SELECT * FROM claim_meta(${ws}::uuid)`;
  const out = new Map<string, ClaimMeta>();
  for (const r of rows) {
    out.set(String(r.id), {
      entity: String(r.entity),
      attribute: r.attribute as ClaimMeta["attribute"],
      state: r.state as ClaimMeta["state"],
      trust: r.trust as ClaimMeta["trust"],
      roleSet: (r.role_set as RoleKey[]) ?? [],
    });
  }
  return out;
}

/** Claims `role` may see, read under RLS. */
export async function visibleClaims(ws: string, role: RoleKey): Promise<Claim[]> {
  const rows = await withRole(ws, role, (tx) =>
    tx`SELECT * FROM claims WHERE workspace_id = ${ws} ORDER BY entity, attribute, valid_from`);
  return rows.map(toClaim);
}

const standinCall: ModelCall = (opts) => {
  // jsonSchema: the core's JSON schema for endpoints with structured output (ignored if unsupported).
  const withSchema = { ...opts, jsonSchema: STANDIN_JSON_SCHEMA };
  return callJson(withSchema);
};

const cachedStandinCall: ModelCall = (opts) => {
  const withSchema = { ...opts, jsonSchema: STANDIN_JSON_SCHEMA, cacheOnly: true };
  return callJson(withSchema);
};

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface RunTestOptions {
  /** "auto" (default): model when reachable, else cached answers, else deterministic. */
  model?: "auto" | "off" | "cache";
  /** What triggered the run, stored with it (e.g. "pipeline", "re-run", "answer gq_…"). */
  trigger?: string;
  /**
   * Responsibility ids to re-judge. Results for every other responsibility are copied from the
   * latest run of this role (one answer changes one responsibility, so the rest need no model call).
   * Ignored when the role has no earlier run.
   */
  only?: string[];
}

/** Is the workspace's current state covered by an approved snapshot? */
async function isProvisional(ws: string): Promise<boolean> {
  const [row] = await db()`
    SELECT
      (SELECT max(approved_at) FROM snapshots WHERE workspace_id = ${ws}) AS approved,
      (SELECT max(updated_at) FROM claims WHERE workspace_id = ${ws}) AS changed`;
  if (!row?.approved) return true;
  return Boolean(row.changed && new Date(String(row.changed)) > new Date(String(row.approved)));
}

/**
 * Run the stand-in successor for `role`: visible claims read under RLS, restricted decided from
 * claim_meta() (metadata only), model judgement merged with the deterministic reading (the model
 * can only lower coverage), named owners from the plan, B/C/K in code. Stores the run.
 */
export async function runTest(ws: string, role: RoleKey, opts: RunTestOptions = {}): Promise<TestRun> {
  const pack = await getWorkspacePack(ws);
  const lpack = lacunaPack(pack);
  const [resps, visible, meta, plan] = await Promise.all([
    listResponsibilities(ws),
    visibleClaims(ws, role),
    claimMeta(ws, role),
    listPlanItems(ws),
  ]);
  const usable: VisibleClaim[] = visible.filter((c) => c.state === "active" || c.state === "conflicting");
  const checks = checksByResp(resps, lpack);

  const today = await workspaceNow(ws);
  // `only`: re-judge these responsibilities (and any the earlier run does not know), copy the rest.
  const prev = opts.only && opts.only.length > 0 ? await getLatestTestRun(ws, role) : null;
  const prevResps = new Set((prev?.results ?? []).map((r) => r.responsibilityId));
  const allResps = resps;
  const judged = prev ? allResps.filter((r) => opts.only!.includes(r.id) || !prevResps.has(r.id)) : allResps;
  const det = await runStandin({ resps: judged, role, visibleClaims: usable, allClaimsMeta: meta, pack: lpack, today });
  let results = det.results;
  let modelUsed = false;
  let modelNote: string | null = null;

  const envMode = process.env.LACUNA_MODEL;
  const mode = opts.model ?? (envMode === "off" || envMode === "cache" ? envMode : "auto");
  if (mode !== "off" && usable.length > 0) {
    let call: ModelCall | undefined;
    if (mode === "cache") call = cachedStandinCall;
    else call = (await modelAvailable()) ? standinCall : cachedStandinCall;
    const perResp = await mapLimit(judged, MODEL_CONCURRENCY, (r) =>
      runStandin({ resps: [r], role, visibleClaims: usable, allClaimsMeta: meta, pack: lpack, call, today }));
    const modelResults = perResp.filter((p) => p.modelUsed).flatMap((p) => p.results);
    const errors = perResp.flatMap((p) => p.errors);
    modelUsed = modelResults.length > 0;
    results = mergeJudgements(modelResults, det.results);
    if (errors.length) {
      const unavailable = errors.filter((e) => /not in cache|not configured|timed out|HTTP|fetch/i.test(e.error)).length;
      modelNote = unavailable === errors.length
        ? `Model unavailable for ${errors.length} responsibilit${errors.length === 1 ? "y" : "ies"}: deterministic reading used.`
        : `Model answer unusable for ${errors.map((e) => e.responsibilityKey).join(", ")}: deterministic reading used.`;
    }
  }

  // The label of a result is the strongest trust among the claims it cites, not among every claim
  // that could have satisfied the check. So a check the stand-in closes on a colleague's answer
  // reads Second-hand even when a record on the same topic exists, and K does not count it.
  const trustOf = new Map(usable.map((c) => [c.id, c.trust]));
  results = results.map((r) => {
    if (r.claimIds.length === 0 || (r.coverage !== "covered" && r.coverage !== "partial")) return r;
    const cited = r.claimIds.map((id) => trustOf.get(id)).filter((t): t is Trust => !!t);
    return cited.length > 0 ? { ...r, bestTrust: strongestTrust(cited) } : r;
  });

  if (prev) {
    // A re-test of one responsibility follows new evidence (an answer, a trace). New evidence cannot
    // take away what the record already supported: a check keeps its earlier, better result as long
    // as every claim it rested on is still live and visible. This also keeps the model's judgement
    // of the unchanged checks from drifting when the prompt gains a claim.
    const liveIds = new Set(usable.map((c) => c.id));
    const before = new Map(prev.results.map((r) => [gapKey(r.responsibilityId, r.checkKey), r]));
    const rank: Record<Coverage, number> = { covered: 3, partial: 2, conflicting: 1, missing: 0, restricted: 0 };
    results = results.map((r) => {
      const was = before.get(gapKey(r.responsibilityId, r.checkKey));
      if (!was || rank[was.coverage] <= rank[r.coverage]) return r;
      if (was.claimIds.length === 0 || !was.claimIds.every((id) => liveIds.has(id))) return r;
      return was;
    });
    // Keep the inventory order: fresh results for the judged responsibilities, the earlier ones for the rest.
    const judgedIds = new Set(judged.map((r) => r.id));
    results = allResps.flatMap((r) =>
      judgedIds.has(r.id) ? results.filter((x) => x.responsibilityId === r.id) : prev.results.filter((x) => x.responsibilityId === r.id));
  }
  results = markPartlyRestricted(results, resps, checks, meta, role);
  const named = namedOwnersFromPlan(openBlockingGaps(results, checks), plan);
  const scores = computeScores(results, checks, named);
  const provisional = await isProvisional(ws);
  const id = `trn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}_${role}`;
  const [row] = await db()`
    INSERT INTO test_runs (workspace_id, id, role, scores, results, provisional, model_used, trigger, model_note)
    VALUES (${ws}, ${id}, ${role}, ${JSON.stringify(scores)}::jsonb, ${JSON.stringify(results)}::jsonb,
      ${provisional}, ${modelUsed}, ${opts.trigger ?? "run"}, ${modelNote})
    RETURNING *`;
  return toTestRun(row);
}

export interface TestRunSummary {
  id: string;
  createdAt: string;
  scores: Scores;
  provisional: boolean;
  modelUsed: boolean;
  trigger: string;
  modelNote: string | null;
}

/** Score history for a role, oldest first (for "score over time"). */
export async function testHistory(ws: string, role: RoleKey, limit = 30): Promise<TestRunSummary[]> {
  const rows = await db()`
    SELECT id, created_at, scores, provisional, model_used, trigger, model_note FROM test_runs
    WHERE workspace_id = ${ws} AND role = ${role} ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.reverse().map((r) => ({
    id: String(r.id),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    scores: (typeof r.scores === "string" ? JSON.parse(r.scores) : r.scores) as Scores,
    provisional: Boolean(r.provisional),
    modelUsed: Boolean(r.model_used),
    trigger: String(r.trigger ?? "run"),
    modelNote: (r.model_note as string | null) ?? null,
  }));
}

/** Section 4 scores from check results (pure; kept for callers that weigh results themselves). */
export function scoreResults(results: CheckResult[], weightOf: (r: CheckResult) => number): Scores {
  let b = 0;
  let sumW = 0;
  let sumWS = 0;
  let sumWSRecord = 0;
  for (const r of results) {
    const w = weightOf(r);
    if (w === 5 && r.coverage !== "covered") b++;
    if (r.coverage === "restricted") continue;
    const s = r.coverage === "covered" ? 1 : r.coverage === "partial" ? 0.5 : 0;
    sumW += w;
    sumWS += w * s;
    if (s > 0 && r.bestTrust && RECORD_TRUST.has(r.bestTrust)) sumWSRecord += w * s;
  }
  return { b, c: sumW ? sumWS / sumW : 0, k: sumWS ? sumWSRecord / sumWS : null };
}

// ---------------------------------------------------------------------------
// Gap questions
// ---------------------------------------------------------------------------

export interface QuestionView extends GapQuestion {
  weight: number | null;
  urgency: number | null;
  claimIds: string[];
  scoreDelta: string | null;
  answeredAt: string | null;
}

function toQuestionView(r: Record<string, unknown>): QuestionView {
  return {
    ...toGapQuestion(r),
    weight: r.weight === null || r.weight === undefined ? null : Number(r.weight),
    urgency: r.urgency === null || r.urgency === undefined ? null : Number(r.urgency),
    claimIds: Array.isArray(r.claim_ids) ? (r.claim_ids as string[]) : [],
    scoreDelta: (r.score_delta as string | null) ?? null,
    answeredAt: r.answered_at instanceof Date ? r.answered_at.toISOString() : (r.answered_at as string | null) ?? null,
  };
}

/** Open questions by rank, then answered ones (newest first). */
export async function listQuestions(ws: string): Promise<QuestionView[]> {
  const rows = await db()`
    SELECT * FROM gap_questions WHERE workspace_id = ${ws}
    ORDER BY answered_claim_id IS NOT NULL, CASE WHEN answered_claim_id IS NULL THEN rank END, answered_at DESC NULLS LAST`;
  return rows.map(toQuestionView);
}

/**
 * Rank the successor's gaps (weight × uncertainty × urgency), keep the top 10 as questions for the
 * leaver. Text is built only from claims the leaver may see. Unanswered questions are replaced;
 * answered ones are kept and their checks are not asked again.
 */
export async function buildQuestions(ws: string): Promise<GapQuestion[]> {
  const sql = db();
  const pack = await getWorkspacePack(ws);
  const lpack = lacunaPack(pack);
  const successor = pack.successorRole as RoleKey;
  const run = (await getLatestTestRun(ws, successor)) ?? (await runTest(ws, successor, { trigger: "questions" }));
  const resps = await listResponsibilities(ws);
  const respById = new Map(resps.map((r) => [r.id, r]));
  const checks = checksByResp(resps, lpack);
  const now = await workspaceNow(ws);

  const answered = await sql`SELECT responsibility_id, check_key FROM gap_questions WHERE workspace_id = ${ws} AND answered_claim_id IS NOT NULL`;
  const answeredKeys = new Set(answered.map((a) => gapKey(String(a.responsibility_id), String(a.check_key))));
  const open = run.results.filter((r) => !answeredKeys.has(gapKey(r.responsibilityId, r.checkKey)));
  const ranked = rankGaps(open, resps, checks, now);
  const leaverClaims = await visibleClaims(ws, pack.leaverRole as RoleKey);

  await sql.begin(async (tx) => {
    await tx`DELETE FROM gap_questions WHERE workspace_id = ${ws} AND answered_claim_id IS NULL`;
    for (const g of ranked) {
      const resp = respById.get(g.responsibilityId)!;
      const check = findCheck(checks, g.responsibilityId, g.checkKey)!;
      const text = questionText(g, resp, check, resp.kind, leaverClaims, pack.leaverRole as RoleKey);
      const id = `gq_${sha256Hex(`${g.responsibilityId}|${g.checkKey}`).slice(0, 12)}`;
      await tx`
        INSERT INTO gap_questions (workspace_id, id, rank, responsibility_id, check_key, gap_type, text, score, weight, urgency, claim_ids)
        VALUES (${ws}, ${id}, ${g.rank}, ${g.responsibilityId}, ${g.checkKey}, ${g.gapType}, ${text}, ${g.score},
          ${g.weight}, ${g.urgency}, ${g.claimIds}::text[])
        ON CONFLICT (workspace_id, id) DO UPDATE SET rank = EXCLUDED.rank, gap_type = EXCLUDED.gap_type, text = EXCLUDED.text,
          score = EXCLUDED.score, weight = EXCLUDED.weight, urgency = EXCLUDED.urgency, claim_ids = EXCLUDED.claim_ids`;
    }
  });
  return (await listQuestions(ws));
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export type AnswerResult =
  | { ok: true; claimId: string; before: Scores | null; after: Scores; delta: string }
  | { ok: false; error: string };

const INTERVIEW_SOURCE = "src_interview";

/**
 * The leaver answers a gap question. The answer is masked (Tether), stored as an `interview`
 * segment and a `leaver_said` claim whose role set is the default narrowed by the leaver (never
 * widened; the leaver and the approver always keep it). Then the successor test re-runs and the
 * score change is stored with the question.
 */
export async function answerQuestion(
  ws: string, questionId: string, answer: string, actor: RoleKey, narrowRoles?: RoleKey[],
): Promise<AnswerResult> {
  const sql = db();
  const pack = await getWorkspacePack(ws);
  const lpack = lacunaPack(pack);
  const leaverRole = pack.leaverRole as RoleKey;
  const successor = pack.successorRole as RoleKey;
  if (actor !== leaverRole) return { ok: false, error: "Only the leaver can answer gap questions." };
  // Recovery: while the approver has marked the leaver as unreachable, the leaver's answer boxes are closed.
  if ((await getWorkspace(ws))?.leaverUnreachable) {
    return {
      ok: false,
      error: `${leaverName(pack) || "The leaver"} is marked as unreachable. ${roleLabel(pack.approverRole, pack)} can switch this off.`,
    };
  }
  const text = (answer ?? "").trim();
  if (text.length < 2) return { ok: false, error: "Write an answer first." };
  if (text.length > 4000) return { ok: false, error: "Keep the answer under 4000 characters." };

  const [qRow] = await sql`SELECT * FROM gap_questions WHERE workspace_id = ${ws} AND id = ${questionId}`;
  if (!qRow) return { ok: false, error: "Question not found." };
  const q = toGapQuestion(qRow);
  if (q.answeredClaimId) return { ok: false, error: "This question is already answered." };
  const [rRow] = await sql`SELECT * FROM responsibilities WHERE workspace_id = ${ws} AND id = ${q.responsibilityId}`;
  if (!rRow) return { ok: false, error: "Responsibility not found." };
  const resp = toResponsibility(rRow);
  const check: LacunaCheck | undefined = checksFor(resp, lpack).find((c) => c.key === q.checkKey);
  if (!check) return { ok: false, error: "Check not found in the setting pack." };

  // Role set: the pack default narrowed by the leaver; leaver and approver always keep it.
  const base = pack.uploadDefaults.roleSet as RoleKey[];
  const keep = new Set<RoleKey>([leaverRole, pack.approverRole as RoleKey]);
  const narrowTo = narrowRoles && narrowRoles.length > 0
    ? base.filter((r) => narrowRoles.includes(r) || keep.has(r))
    : null;

  // Mask before storage. Contact placeholders get workspace-unique numbers.
  const masked = await maskAnswer(ws, text);
  const maskedText = masked.text;

  const people = await listPeople(ws);
  const leaverIds = leaverPersonIds(people, leaverName(pack), pack.leaverPerson.aliases);
  // No person record for the leaver (an uploaded workspace): no author id; the role is in the audit row.
  const leaverId = people.find((p) => leaverIds.includes(p.id) && p.emailHmac)?.id ?? leaverIds[0] ?? null;
  const ts = new Date().toISOString();
  const { segment, claim: draft } = answerToDrafts(
    maskedText,
    { id: q.id, text: q.text, resp, check, roleSet: base, entityLabel: entityLabel(resp.entities[0] ?? "", pack) || resp.title },
    leaverId,
    { leaverName: leaverName(pack) || "The leaver", ts, sourceId: INTERVIEW_SOURCE, workspaceId: ws, narrowTo },
  );
  const roleSet = draft.roleSet;
  const id = makeClaimId(draft.entity, draft.attribute, draft.value, [segment.id]);
  const claim: Claim = {
    id, workspaceId: ws, entity: draft.entity, entityLabel: draft.entityLabel, attribute: draft.attribute,
    value: draft.value.slice(0, 1000), statement: draft.statement, citations: draft.citations, trust: "leaver_said",
    state: "active", stateNote: null, supersededBy: null, roleSet, validFrom: ts, authorId: leaverId,
    sourceKinds: ["interview"], importance: importanceOf(check.weight), tier: "B", review: "pending",
    reviewNote: null, origin: "leaver_answer", supportCheck: null,
  };
  claim.tier = tierFor(claim, pack);

  const before = await getLatestTestRun(ws, successor);
  await sql.begin(async (tx) => {
    await persistAnswer(tx, ws, {
      source: { id: INTERVIEW_SOURCE, name: "Gap interview", roleSet: base },
      segment,
      claim,
      masked,
      contactRoles: (pack.contactsRoles as RoleKey[]).filter((r) => roleSet.includes(r)),
      event: {
        origin: "leaver_answer", questionId, segmentId: segment.id, trust: "leaver_said", roleSet,
        narrowed: roleSet.length < base.length,
      },
      actor,
    });
    await tx`UPDATE gap_questions SET answered_claim_id = ${claim.id}, answered_at = now()
      WHERE workspace_id = ${ws} AND id = ${questionId}`;
  });
  await audit(ws, actor, "answer_question", { questionId, claimId: claim.id, roleSet });

  const trigger = `answer ${questionId}`;
  // Re-test as the successor (the score shown) and as every other role the pack tests.
  const [after] = await Promise.all(pack.testRoles.map((role) => runTest(ws, role, { trigger })));
  const checks = checksByResp(await listResponsibilities(ws), lpack);
  const delta = before ? scoreDelta(before, after, checks) : `B ${after.scores.b} · C ${Math.round(after.scores.c * 100)}%`;
  await sql`UPDATE gap_questions SET score_delta = ${delta} WHERE workspace_id = ${ws} AND id = ${questionId}`;
  return { ok: true, claimId: claim.id, before: before?.scores ?? null, after: after.scores, delta };
}

// ---------------------------------------------------------------------------
// Continuation plan and release
// ---------------------------------------------------------------------------

export interface BlockingGap {
  responsibilityId: string;
  responsibilityKey: string;
  responsibilityTitle: string;
  checkKey: string;
  checkLabel: string;
  coverage: Exclude<Coverage, "covered">;
  note: string;
  plan: PlanItem | null;
}

/** Blocking checks (weight 5) not covered in the latest test for `role` (default successor). */
export async function listBlockingGaps(ws: string, role?: RoleKey): Promise<BlockingGap[]> {
  const pack = await getWorkspacePack(ws);
  const lpack = lacunaPack(pack);
  const run = await getLatestTestRun(ws, role ?? (pack.successorRole as RoleKey));
  if (!run) return [];
  const resps = await listResponsibilities(ws);
  const byId = new Map(resps.map((r) => [r.id, r]));
  const checks = checksByResp(resps, lpack);
  const plans = new Map((await listPlanItems(ws)).map((p) => [gapKey(p.responsibilityId, p.checkKey), p]));
  const notes = new Map(run.results.map((r) => [gapKey(r.responsibilityId, r.checkKey), r.note]));
  return openBlockingGaps(run.results, checks).flatMap((g) => {
    const r = byId.get(g.responsibilityId);
    const check = findCheck(checks, g.responsibilityId, g.checkKey);
    if (!r || !check) return [];
    return [{
      responsibilityId: r.id, responsibilityKey: r.key, responsibilityTitle: r.title, checkKey: check.key,
      checkLabel: check.label, coverage: g.coverage, note: notes.get(gapKey(r.id, check.key)) ?? "",
      plan: plans.get(gapKey(r.id, check.key)) ?? null,
    }];
  });
}

export function planComplete(p: PlanItem | null): boolean {
  return Boolean(p && p.owner.trim() && /^\d{4}-\d{2}-\d{2}/.test(p.dueDate ?? "") && p.riskNote.trim());
}

/** Continuation plan entry for an open blocking gap (owner, due date, approver's risk note). Approver only. */
export async function savePlanItem(ws: string, item: PlanItem, actor: RoleKey): Promise<{ ok: true } | { ok: false; error: string }> {
  const pack = await getWorkspacePack(ws);
  if (actor !== pack.approverRole) {
    return { ok: false, error: `Only the approver (${roleLabel(pack.approverRole, pack)}) can set the continuation plan.` };
  }
  const owner = (item.owner ?? "").trim().slice(0, 200);
  const riskNote = (item.riskNote ?? "").trim().slice(0, 2000);
  const due = /^(\d{4}-\d{2}-\d{2})/.exec((item.dueDate ?? "").trim())?.[1] ?? null;
  if (item.dueDate?.trim() && !due) return { ok: false, error: "Use a date like 2026-11-30." };
  const [r] = await db()`SELECT * FROM responsibilities WHERE workspace_id = ${ws} AND id = ${item.responsibilityId}`;
  if (!r) return { ok: false, error: "Responsibility not found." };
  const resp = toResponsibility(r);
  if (!checksFor(resp, lacunaPack(pack)).some((c) => c.key === item.checkKey)) return { ok: false, error: "Check not found." };
  await db()`
    INSERT INTO plan_items (workspace_id, responsibility_id, check_key, owner, due_date, risk_note)
    VALUES (${ws}, ${item.responsibilityId}, ${item.checkKey}, ${owner}, ${due}::date, ${riskNote})
    ON CONFLICT (workspace_id, responsibility_id, check_key) DO UPDATE SET
      owner = EXCLUDED.owner, due_date = EXCLUDED.due_date, risk_note = EXCLUDED.risk_note, updated_at = now()`;
  await audit(ws, actor, "plan_item", { responsibilityId: item.responsibilityId, checkKey: item.checkKey, owner, due });
  // A named owner on a restricted blocking check changes B: re-score from the latest run (no model call).
  await rescoreLatest(ws, pack.successorRole as RoleKey, "plan item");
  return { ok: true };
}

/** Recompute B/C/K of the latest run with the current plan (named owners) and store it as a new run. */
async function rescoreLatest(ws: string, role: RoleKey, trigger: string): Promise<TestRun | null> {
  const run = await getLatestTestRun(ws, role);
  if (!run) return null;
  const checks = checksByResp(await listResponsibilities(ws), lacunaPack(await getWorkspacePack(ws)));
  const named = namedOwnersFromPlan(openBlockingGaps(run.results, checks), await listPlanItems(ws));
  const scores = computeScores(run.results, checks, named);
  if (scores.b === run.scores.b && scores.c === run.scores.c && scores.k === run.scores.k) return run;
  const id = `trn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}_${role}`;
  const [row] = await db()`
    INSERT INTO test_runs (workspace_id, id, role, scores, results, provisional, model_used, trigger)
    VALUES (${ws}, ${id}, ${role}, ${JSON.stringify(scores)}::jsonb, ${JSON.stringify(run.results)}::jsonb,
      ${run.provisional}, ${run.modelUsed}, ${trigger})
    RETURNING *`;
  return toTestRun(row);
}

export interface ReleaseInfo extends ReleaseState {
  scores: Scores | null;
  gaps: BlockingGap[];
}

/** Release state for Relay: the core release rule over the latest successor run and the plan. */
export async function releaseInfo(ws: string): Promise<ReleaseInfo> {
  const pack = await getWorkspacePack(ws);
  const run = await getLatestTestRun(ws, pack.successorRole as RoleKey);
  const gaps = await listBlockingGaps(ws);
  const plan = await listPlanItems(ws);
  const scores = run?.scores ?? null;
  const state = releaseState(
    scores ?? { b: 0, c: 0, k: null },
    gaps.map((g) => ({ responsibilityId: g.responsibilityId, checkKey: g.checkKey, coverage: g.coverage })),
    plan,
  );
  return { ...state, scores, gaps };
}

/** Segment view helper for pages: responsibility ids -> claim ids -> first cited segment. */
export async function citedSegments(ws: string, role: RoleKey, claimIds: string[]): Promise<Record<string, string | null>> {
  if (claimIds.length === 0) return {};
  const rows = await withRole(ws, role, (tx) =>
    tx`SELECT id, citations FROM claims WHERE workspace_id = ${ws} AND id = ANY(${claimIds}::text[])`);
  const out: Record<string, string | null> = {};
  for (const r of rows) {
    const cits = (typeof r.citations === "string" ? JSON.parse(r.citations) : r.citations) as { segmentId: string; accepted?: boolean }[];
    out[String(r.id)] = cits.find((c) => c.accepted !== false)?.segmentId ?? cits[0]?.segmentId ?? null;
  }
  return out;
}
