// WALKING-SKELETON STUB: replaced by the Lacuna builder.
//
// Public entry points (keep these names and shapes):
//   buildInventory(ws)                          -> { responsibilities }  responsibilities from template + board
//   runTest(ws, role)                           -> TestRun               coverage per check, B/C/K, stored
//   buildQuestions(ws)                          -> GapQuestion[]         top 10 ranked gap questions
//   answerQuestion(ws, questionId, text, actor, narrowRoles?) -> AnswerResult   leaver answers, re-test
//   listBlockingGaps(ws, role?)                 -> BlockingGap[]         open blocking checks (+ plan item)
//   savePlanItem(ws, item, actor)               -> { ok } | { ok:false, error }
//   scoreResults(results, checks)               -> Scores                section 4 formulas (pure)
//
// What this stub really does (deterministic, no model):
//   * inventory = pack.roleTemplates[successorRole] + open task-board cards, merged by entity.
//   * test = the deterministic fallback of section 4 over claims read through withRole(role):
//     covered (from_record / corroborated / leaver_said), partial (other trust), conflicting,
//     restricted (no visible evidence but some exists for other roles; counted with an admin
//     count query, never shown), else missing. B, C, K from the section 4 formulas.
//   * questions = rank by weight x uncertainty x urgency, top 10, template text per wTag and
//     gap type. Text only names the responsibility and the check, never a claim value.
import { db } from "@/lib/db/client";
import { toClaim, toGapQuestion, toPlanItem, toResponsibility, toSegment, toTestRun } from "@/lib/db/mappers";
import { listClaims, listResponsibilities, getLatestTestRun, audit } from "@/lib/db/queries";
import { getPack, checklistFor, entityLabel, type Pack } from "@/lib/pack";
import { matchEntity, claimId } from "@/lib/attest";
import { segmentId, textHash } from "@/lib/tether/ids";
import { maskText } from "@/lib/tether/mask";
import { sha256Hex } from "@/lib/text/norm";
import type {
  CheckDef, CheckResult, Claim, Coverage, GapQuestion, Importance, PlanItem, Responsibility, RoleKey,
  Scores, TestRun, Trust,
} from "@/lib/types";

const STRONG: Trust[] = ["from_record", "corroborated", "leaver_said"];
const RECORD: Trust[] = ["from_record", "corroborated"];
const DONE_STATUS = /^(done|closed|complete|completed|cancelled|canceled|resolved)$/i;

function isoDate(v: unknown): string | null {
  const s = v === null || v === undefined ? "" : String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/** Build (or refresh) the responsibility inventory. Idempotent; keeps `confirmed`. */
export async function buildInventory(ws: string): Promise<{ responsibilities: number }> {
  const sql = db();
  const pack = getPack();
  const items: Omit<Responsibility, "workspaceId">[] = [];
  const byEntity = new Map<string, Omit<Responsibility, "workspaceId">>();

  for (const t of pack.roleTemplates[pack.successorRole] ?? []) {
    const r = {
      id: `rsp_${t.key}`, key: t.key, title: t.title, kind: t.kind, entities: [...t.entities],
      origin: "role_template" as const, originDetail: `Role template for ${pack.successorRole}`,
      dueDate: null, confirmed: false,
    };
    items.push(r);
    for (const e of t.entities) byEntity.set(e, r);
  }

  const taskRows = await sql`
    SELECT DISTINCT ON (id) * FROM segments WHERE workspace_id = ${ws} AND kind = 'task'
    ORDER BY id, version DESC`;
  let n = items.length;
  for (const seg of taskRows.map(toSegment)) {
    const m = seg.meta ?? {};
    if (DONE_STATUS.test(String(m.status ?? ""))) continue;
    const title = String(m.title ?? seg.text.split("\n")[0]);
    const ent = matchEntity(`${title} ${m.labels ?? ""} ${m.description ?? ""}`, title, pack);
    const due = isoDate(m.due);
    const existing = byEntity.get(ent.key);
    if (existing) {
      if (!existing.originDetail.includes(String(m.id ?? ""))) existing.originDetail += `; board card ${m.id ?? seg.id}`;
      if (due && (!existing.dueDate || due < existing.dueDate)) existing.dueDate = due;
      continue;
    }
    n++;
    const r = {
      id: `rsp_task_${ent.key}`, key: `R${String(n).padStart(2, "0")}`, title, kind: "unfinished_work" as const,
      entities: [ent.key], origin: "task_board" as const, originDetail: `Board card ${m.id ?? seg.id}`,
      dueDate: due, confirmed: false,
    };
    items.push(r);
    byEntity.set(ent.key, r);
  }

  for (const r of items) {
    await sql`
      INSERT INTO responsibilities (workspace_id, id, key, title, kind, entities, origin, origin_detail, due_date)
      VALUES (${ws}, ${r.id}, ${r.key}, ${r.title}, ${r.kind}, ${r.entities}::text[], ${r.origin}, ${r.originDetail}, ${r.dueDate}::date)
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        title = EXCLUDED.title, kind = EXCLUDED.kind, entities = EXCLUDED.entities,
        origin_detail = EXCLUDED.origin_detail, due_date = EXCLUDED.due_date`;
  }
  return { responsibilities: items.length };
}

/** Section 4 scores from check results (pure). */
export function scoreResults(results: CheckResult[], weightOf: (r: CheckResult) => number): Scores {
  let b = 0;
  let sumW = 0;
  let sumWS = 0;
  let sumWSRecord = 0;
  for (const r of results) {
    const w = weightOf(r);
    if (w === 5 && r.coverage !== "covered") b++; // restricted blocking counts until an owner is named
    if (r.coverage === "restricted") continue;
    const s = r.coverage === "covered" ? 1 : r.coverage === "partial" ? 0.5 : 0;
    sumW += w;
    sumWS += w * s;
    if (s > 0 && r.bestTrust && RECORD.includes(r.bestTrust)) sumWSRecord += w * s;
  }
  return { b, c: sumW ? sumWS / sumW : 0, k: sumWS ? sumWSRecord / sumWS : null };
}

function rankTrust(t: Trust): number {
  return ["from_record", "corroborated", "leaver_said", "second_hand", "inferred", "ranked_options"].indexOf(t);
}

/** Run the successor test for `role` (claims read under RLS) and store the run. */
export async function runTest(ws: string, role: RoleKey): Promise<TestRun> {
  const pack = getPack();
  const visible = (await listClaims(ws, { role })).filter((c) => c.state !== "dropped" && c.state !== "superseded");
  const visibleIds = new Set(visible.map((c) => c.id));
  const all = (await db()`SELECT * FROM claims WHERE workspace_id = ${ws} AND state NOT IN ('dropped', 'superseded')`).map(toClaim);
  const responsibilities = await listResponsibilities(ws);
  const results: CheckResult[] = [];
  const weights = new Map<string, number>();

  for (const r of responsibilities) {
    for (const check of checklistFor(r.kind, pack)) {
      const match = (c: Claim) => r.entities.includes(c.entity) && check.attributes.includes(c.attribute);
      const mine = visible.filter(match);
      const active = mine.filter((c) => c.state === "active");
      const conflicting = mine.filter((c) => c.state === "conflicting");
      let coverage: Coverage;
      let note = "";
      let used: Claim[] = [];
      if (active.some((c) => STRONG.includes(c.trust))) {
        coverage = "covered";
        used = active.filter((c) => STRONG.includes(c.trust));
      } else if (active.length) {
        coverage = "partial";
        used = active;
        note = "Only inferred evidence.";
      } else if (conflicting.length) {
        coverage = "conflicting";
        used = conflicting;
        note = "Sources disagree.";
      } else if (all.some((c) => match(c) && !visibleIds.has(c.id))) {
        coverage = "restricted";
        note = "Evidence exists but is not visible to this role.";
      } else {
        coverage = "missing";
        note = `Nothing in the record says this (${check.label.toLowerCase()}).`;
      }
      used.sort((a, b) => rankTrust(a.trust) - rankTrust(b.trust));
      const res: CheckResult = {
        responsibilityId: r.id,
        checkKey: check.key,
        coverage,
        claimIds: used.map((c) => c.id),
        bestTrust: used[0]?.trust ?? null,
        note,
      };
      weights.set(`${r.id}|${check.key}`, check.weight);
      results.push(res);
    }
  }

  const scores = scoreResults(results, (x) => weights.get(`${x.responsibilityId}|${x.checkKey}`) ?? 1);
  const id = `trn_${Date.now().toString(36)}_${role}`;
  await db()`
    INSERT INTO test_runs (workspace_id, id, role, scores, results, provisional, model_used)
    VALUES (${ws}, ${id}, ${role}, ${JSON.stringify(scores)}::jsonb, ${JSON.stringify(results)}::jsonb, true, false)`;
  const [row] = await db()`SELECT * FROM test_runs WHERE workspace_id = ${ws} AND id = ${id}`;
  return toTestRun(row);
}

const WTAG_TEMPLATE: Record<string, (label: string, title: string) => string> = {
  WHO: (l, t) => `Who is the ${l.toLowerCase()} for "${t}"?`,
  WHERE: (l, t) => `Where does "${t}" stand: ${l.toLowerCase()}?`,
  HOW: (l, t) => `For "${t}", what are the ${l.toLowerCase()}, step by step?`,
  WHEN: (l, t) => `For "${t}", what is the ${l.toLowerCase()}?`,
  WHY: (l, t) => `For "${t}", what should the successor know about ${l.toLowerCase()}?`,
};
const GAP_SUFFIX: Record<GapQuestion["gapType"], string> = {
  missing: "The record has nothing on this.",
  partial: "The record only hints at this.",
  conflicting: "Two sources disagree; which one is right?",
};
const UNCERTAINTY: Record<GapQuestion["gapType"], number> = { missing: 1, conflicting: 0.8, partial: 0.5 };

/** Rank the successor's gaps and keep the top 10 as questions for the leaver. */
export async function buildQuestions(ws: string): Promise<GapQuestion[]> {
  const sql = db();
  const pack = getPack();
  const run = await getLatestTestRun(ws, pack.successorRole);
  if (!run) return [];
  const responsibilities = new Map((await listResponsibilities(ws)).map((r) => [r.id, r]));
  const now = Date.now();
  const candidates: Omit<GapQuestion, "rank" | "id" | "workspaceId" | "answeredClaimId">[] = [];
  for (const res of run.results) {
    if (res.coverage !== "missing" && res.coverage !== "partial" && res.coverage !== "conflicting") continue;
    const r = responsibilities.get(res.responsibilityId);
    if (!r) continue;
    const check = checklistFor(r.kind, pack).find((c) => c.key === res.checkKey);
    if (!check) continue;
    const gapType = res.coverage;
    const due = r.dueDate ? Date.parse(r.dueDate) : NaN;
    const urgency = Number.isFinite(due) && due - now <= 14 * 86_400_000 ? 1.5 : 1;
    const score = check.weight * UNCERTAINTY[gapType] * urgency;
    const text = `${(WTAG_TEMPLATE[check.wTag] ?? WTAG_TEMPLATE.HOW)(check.label, r.title)} ${GAP_SUFFIX[gapType]}`;
    candidates.push({ responsibilityId: r.id, checkKey: check.key, gapType, text, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.responsibilityId.localeCompare(b.responsibilityId));
  const top = candidates.slice(0, 10);

  const answered = await sql`SELECT responsibility_id, check_key FROM gap_questions WHERE workspace_id = ${ws} AND answered_claim_id IS NOT NULL`;
  const answeredKeys = new Set(answered.map((a) => `${a.responsibility_id}|${a.check_key}`));
  await sql`DELETE FROM gap_questions WHERE workspace_id = ${ws} AND answered_claim_id IS NULL`;
  let rank = 0;
  for (const q of top) {
    if (answeredKeys.has(`${q.responsibilityId}|${q.checkKey}`)) continue;
    rank++;
    const id = `gq_${sha256Hex(`${q.responsibilityId}|${q.checkKey}`).slice(0, 12)}`;
    await sql`
      INSERT INTO gap_questions (workspace_id, id, rank, responsibility_id, check_key, gap_type, text, score)
      VALUES (${ws}, ${id}, ${rank}, ${q.responsibilityId}, ${q.checkKey}, ${q.gapType}, ${q.text}, ${q.score})
      ON CONFLICT (workspace_id, id) DO UPDATE SET rank = EXCLUDED.rank, gap_type = EXCLUDED.gap_type,
        text = EXCLUDED.text, score = EXCLUDED.score`;
  }
  return (await sql`SELECT * FROM gap_questions WHERE workspace_id = ${ws} ORDER BY answered_claim_id IS NOT NULL, rank`).map(toGapQuestion);
}

export type AnswerResult =
  | { ok: true; claimId: string; before: Scores | null; after: Scores }
  | { ok: false; error: string };

function importanceOf(check: CheckDef): Importance {
  return check.weight === 5 ? "blocking" : check.weight === 3 ? "important" : "normal";
}

/**
 * The leaver answers a gap question. The answer becomes an `interview` segment (author = leaver)
 * and a claim with trust leaver_said; then the successor test re-runs. Only the leaver may answer;
 * the leaver may narrow the answer's role set, never widen it.
 */
export async function answerQuestion(
  ws: string, questionId: string, answer: string, actor: RoleKey, narrowRoles?: RoleKey[],
): Promise<AnswerResult> {
  const sql = db();
  const pack = getPack();
  if (actor !== pack.leaverRole) return { ok: false, error: "Only the leaver can answer gap questions." };
  const text = answer.trim();
  if (text.length < 2) return { ok: false, error: "Write an answer first." };
  if (text.length > 4000) return { ok: false, error: "Keep the answer under 4000 characters." };
  const [qRow] = await sql`SELECT * FROM gap_questions WHERE workspace_id = ${ws} AND id = ${questionId}`;
  if (!qRow) return { ok: false, error: "Question not found." };
  const q = toGapQuestion(qRow);
  if (q.answeredClaimId) return { ok: false, error: "This question is already answered." };
  const [rRow] = await sql`SELECT * FROM responsibilities WHERE workspace_id = ${ws} AND id = ${q.responsibilityId}`;
  if (!rRow) return { ok: false, error: "Responsibility not found." };
  const r = toResponsibility(rRow);
  const check = checklistFor(r.kind, pack).find((c) => c.key === q.checkKey);
  if (!check) return { ok: false, error: "Check not found in the setting pack." };

  const base = pack.uploadDefaults.roleSet as RoleKey[];
  let roleSet = narrowRoles?.length ? base.filter((x) => narrowRoles.includes(x)) : [...base];
  for (const must of [pack.leaverRole, pack.approverRole] as RoleKey[]) if (!roleSet.includes(must)) roleSet.push(must);
  roleSet = base.filter((x) => roleSet.includes(x)); // never wider than the default

  const masked = maskText(text, { contactsKey: process.env.CONTACTS_KEY ?? "", people: null });
  const leaverWord = (pack.roles.find((x) => x.key === pack.leaverRole)?.label ?? "").split(/[\s(]/)[0];
  const [leaver] = leaverWord
    ? await sql`SELECT id FROM people WHERE workspace_id = ${ws} AND display_name ILIKE ${leaverWord + "%"} ORDER BY id LIMIT 1`
    : [];
  const authorId = leaver ? String(leaver.id) : null;

  await sql`
    INSERT INTO sources (workspace_id, id, kind, name, role_set, origin)
    VALUES (${ws}, 'src_interview', 'interview', 'Leaver answers', ${base}::text[], 'interview')
    ON CONFLICT (workspace_id, id) DO NOTHING`;
  const ts = new Date().toISOString();
  const [{ n: pos }] = await sql`SELECT count(*)::int AS n FROM segments WHERE workspace_id = ${ws} AND source_id = 'src_interview'`;
  const segId = segmentId("interview", ts, "interview", Number(pos), masked.text);
  await sql`
    INSERT INTO segments (workspace_id, id, version, source_id, source_kind, kind, ts, author_id, thread, position, text, text_hash, role_set, meta)
    VALUES (${ws}, ${segId}, 1, 'src_interview', 'interview', 'answer', ${ts}, ${authorId}, 'interview', ${Number(pos)},
      ${masked.text}, ${textHash(masked.text)}, ${roleSet}::text[], ${JSON.stringify({ questionId })}::jsonb)`;
  await sql`UPDATE sources SET segment_count = segment_count + 1, masked_secrets = masked_secrets + ${masked.secrets}
    WHERE workspace_id = ${ws} AND id = 'src_interview'`;

  const entity = r.entities[0] ?? r.key.toLowerCase();
  const attribute = check.attributes[0];
  const id = claimId(entity, attribute, masked.text, [segId]);
  const claim: Claim = {
    id, workspaceId: ws, entity, entityLabel: entityLabel(entity, pack) || r.title, attribute,
    value: masked.text.slice(0, 300), statement: masked.text,
    citations: [{ segmentId: segId, quote: masked.text, accepted: true, exact: true }],
    trust: "leaver_said", state: "active", stateNote: null, supersededBy: null, roleSet,
    validFrom: ts, authorId, sourceKinds: ["interview"], importance: importanceOf(check),
    tier: roleSet.includes("new_member") && check.weight !== 5 ? "B" : "C",
    review: "pending", reviewNote: null, origin: "leaver_answer", supportCheck: null,
  };
  await sql`
    INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, state,
      role_set, valid_from, author_id, source_kinds, importance, tier, review, origin, source_ids)
    VALUES (${ws}, ${claim.id}, ${claim.entity}, ${claim.entityLabel}, ${claim.attribute}, ${claim.value}, ${claim.statement},
      ${JSON.stringify(claim.citations)}::jsonb, ${claim.trust}, 'active', ${roleSet}::text[], ${ts}, ${authorId},
      ${["interview"]}::text[], ${claim.importance}, ${claim.tier}, 'pending', 'leaver_answer', ${["src_interview"]}::text[])
    ON CONFLICT (workspace_id, id) DO NOTHING`;
  await sql`INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
    VALUES (${ws}, ${claim.id}, 'created', ${JSON.stringify({ origin: "leaver_answer", questionId })}::jsonb, ${actor})`;
  await sql`UPDATE gap_questions SET answered_claim_id = ${claim.id} WHERE workspace_id = ${ws} AND id = ${questionId}`;
  await audit(ws, actor, "answer_question", { questionId, claimId: claim.id, roleSet });

  const before = (await getLatestTestRun(ws, pack.successorRole))?.scores ?? null;
  const after = (await runTest(ws, pack.successorRole)).scores;
  await runTest(ws, "new_member");
  return { ok: true, claimId: claim.id, before, after };
}

export interface BlockingGap {
  responsibilityId: string;
  responsibilityTitle: string;
  checkKey: string;
  checkLabel: string;
  coverage: Coverage;
  plan: PlanItem | null;
}

/** Blocking checks (weight 5) not covered in the latest test for `role` (default successor). */
export async function listBlockingGaps(ws: string, role?: RoleKey): Promise<BlockingGap[]> {
  const pack: Pack = getPack();
  const run = await getLatestTestRun(ws, role ?? pack.successorRole);
  if (!run) return [];
  const responsibilities = new Map((await listResponsibilities(ws)).map((r) => [r.id, r]));
  const plans = new Map(
    (await db()`SELECT * FROM plan_items WHERE workspace_id = ${ws}`).map(toPlanItem).map((p) => [`${p.responsibilityId}|${p.checkKey}`, p]),
  );
  const out: BlockingGap[] = [];
  for (const res of run.results) {
    if (res.coverage === "covered") continue;
    const r = responsibilities.get(res.responsibilityId);
    if (!r) continue;
    const check = checklistFor(r.kind, pack).find((c) => c.key === res.checkKey);
    if (!check || check.weight !== 5) continue;
    out.push({
      responsibilityId: r.id, responsibilityTitle: r.title, checkKey: check.key, checkLabel: check.label,
      coverage: res.coverage, plan: plans.get(`${r.id}|${check.key}`) ?? null,
    });
  }
  return out;
}

export function planComplete(p: PlanItem | null): boolean {
  return Boolean(p && p.owner.trim() && p.dueDate && p.riskNote.trim());
}

/** Continuation plan entry for an open blocking gap (owner, due date, approver's risk note). */
export async function savePlanItem(ws: string, item: PlanItem, actor: RoleKey): Promise<{ ok: true } | { ok: false; error: string }> {
  const pack = getPack();
  if (actor !== pack.approverRole) return { ok: false, error: "Only the approver can set the continuation plan." };
  const due = isoDate(item.dueDate);
  await db()`
    INSERT INTO plan_items (workspace_id, responsibility_id, check_key, owner, due_date, risk_note)
    VALUES (${ws}, ${item.responsibilityId}, ${item.checkKey}, ${item.owner.trim()}, ${due}::date, ${item.riskNote.trim()})
    ON CONFLICT (workspace_id, responsibility_id, check_key) DO UPDATE SET
      owner = EXCLUDED.owner, due_date = EXCLUDED.due_date, risk_note = EXCLUDED.risk_note, updated_at = now()`;
  await audit(ws, actor, "plan_item", { responsibilityId: item.responsibilityId, checkKey: item.checkKey });
  return { ok: true };
}
