// Gap questions for the leaver (ARCHITECTURE section 4, "Gap questions").
import type {
  CheckDef, CheckResult, Citation, Claim, Coverage, Responsibility, ResponsibilityKind, RoleKey, Segment,
} from "@/lib/types";
import { norm, sha256Hex } from "@/lib/text/norm";
import { findCheck } from "./checks";
import type { LacunaCheck } from "./pack";

export type GapType = "missing" | "partial" | "conflicting";

export const UNCERTAINTY: Record<GapType, number> = { missing: 1, conflicting: 0.8, partial: 0.5 };
export const URGENT_DAYS = 14;
export const URGENCY_SOON = 1.5;
export const MAX_QUESTIONS = 10;
const DAY_MS = 86_400_000;

export interface RankedGap {
  rank: number;
  responsibilityId: string;
  checkKey: string;
  gapType: GapType;
  weight: number;
  uncertainty: number;
  urgency: number;
  score: number;
  /** Claim ids the stand-in cited (for conflicting gaps, the disagreeing claims). */
  claimIds: string[];
}

function isGapType(c: Coverage): c is GapType {
  return c === "missing" || c === "partial" || c === "conflicting";
}

/** Due within 14 days of today (overdue counts as due soon). */
export function isDueSoon(dueDate: string | null, today: string): boolean {
  if (!dueDate) return false;
  const due = Date.parse(dueDate);
  const now = Date.parse(today);
  if (Number.isNaN(due) || Number.isNaN(now)) return false;
  return due - now <= URGENT_DAYS * DAY_MS;
}

/**
 * score = weight × uncertainty (missing 1, conflicting 0.8, partial 0.5) × urgency (1.5 when due within 14 days).
 * Restricted checks are excluded (they go to the approver). Top 10, highest first; ties by
 * responsibility key, then checklist order.
 */
export function rankGaps(
  results: readonly CheckResult[],
  resps: readonly Responsibility[],
  checks: Record<string, readonly CheckDef[]>,
  today: string,
): RankedGap[] {
  const respById = new Map(resps.map((r) => [r.id, r]));
  const scored: (Omit<RankedGap, "rank"> & { respKey: string; order: number })[] = [];
  for (const r of results) {
    if (!isGapType(r.coverage)) continue;
    const resp = respById.get(r.responsibilityId);
    const check = findCheck(checks, r.responsibilityId, r.checkKey);
    if (!resp || !check) continue;
    const uncertainty = UNCERTAINTY[r.coverage];
    const urgency = isDueSoon(resp.dueDate, today) ? URGENCY_SOON : 1;
    scored.push({
      responsibilityId: r.responsibilityId,
      checkKey: r.checkKey,
      gapType: r.coverage,
      weight: check.weight,
      uncertainty,
      urgency,
      score: Math.round(check.weight * uncertainty * urgency * 1000) / 1000,
      claimIds: [...r.claimIds],
      respKey: resp.key,
      order: checks[r.responsibilityId].indexOf(check),
    });
  }
  scored.sort((a, b) =>
    b.score - a.score
    || b.weight - a.weight
    || (a.respKey < b.respKey ? -1 : a.respKey > b.respKey ? 1 : 0)
    || a.order - b.order);
  return scored.slice(0, MAX_QUESTIONS).map((g, i) => ({
    rank: i + 1,
    responsibilityId: g.responsibilityId,
    checkKey: g.checkKey,
    gapType: g.gapType,
    weight: g.weight,
    uncertainty: g.uncertainty,
    urgency: g.urgency,
    score: g.score,
    claimIds: g.claimIds,
  }));
}

// ---------- question text ----------

const MISSING_TEMPLATES: Record<string, string> = {
  // deploy_operate
  access_path: "Where exactly does someone go to work on {resp} (system, page, machine or room), and how do they get access?",
  steps: "What are the exact steps for {resp}, from start to finish, and where is that written down?",
  verify: "After {resp} is done, how does someone check that it actually worked?",
  rollback: "If {resp} breaks at the worst possible moment, what exact steps or command roll it back, and where is that written down?",
  credential_owner: "Who holds the login or key needed for {resp}, and who can grant it to the next person? Name the credential, never the password.",
  // external_relationship
  contact_person: "Who is the person to contact for {resp}, and how do they expect to be reached?",
  last_interaction: "When did you last talk to them about {resp}, and what was agreed?",
  open_commitments: "What has been promised for {resp} that is still open, and to whom?",
  next_date: "What is the next date that matters for {resp}?",
  // recurring_obligation
  cadence: "How often does {resp} have to happen: weekly, each term, or yearly?",
  next_due: "When exactly is {resp} next due?",
  how_to: "What are the exact steps to get {resp} done, and where is that written down?",
  consequence: "What happens if {resp} is missed?",
  // open_decision
  current_state: "Where does {resp} stand right now: what is decided and what is still open?",
  options: "Which options were considered for {resp}, and why were the others ruled out?",
  owner: "Who decides {resp} once you have left?",
  deadline: "By when does {resp} have to be decided?",
  // unfinished_work
  where_it_lives: "Where does the work on {resp} live: which repo, branch, folder or document?",
  last_state: "Where did you leave {resp}: what is done and what is not?",
  next_step: "What is the next concrete step on {resp}, and what does someone need to take it?",
  reviewer: "Who should review or sign off {resp}?",
};
// A setting pack may name some checks differently; give them the same plain text
// instead of the generic "How exactly is {check} done for {resp}" fallback.
Object.assign(MISSING_TEMPLATES, {
  how_to_verify: MISSING_TEMPLATES.verify,
  next_due_date: MISSING_TEMPLATES.next_due,
  how_to_do_it: MISSING_TEMPLATES.how_to,
  consequence_if_missed: MISSING_TEMPLATES.consequence,
  options_considered: MISSING_TEMPLATES.options,
  next_concrete_step: MISSING_TEMPLATES.next_step,
  who_reviews_it: MISSING_TEMPLATES.reviewer,
});

const WTAG_FALLBACK: Record<CheckDef["wTag"], string> = {
  WHO: "Who is responsible for {check} on {resp}?",
  WHERE: "Where can the next person find {check} for {resp}?",
  HOW: "How exactly is {check} done for {resp}, and where is that written down?",
  WHY: "Why does {check} matter for {resp}, and what depends on it?",
  WHEN: "When is {check} for {resp}, exactly?",
};

const KIND_NOUN: Record<ResponsibilityKind, string> = {
  deploy_operate: "this system",
  external_relationship: "this relationship",
  recurring_obligation: "this recurring task",
  open_decision: "this decision",
  unfinished_work: "this work",
};

function fill(tpl: string, resp: Pick<Responsibility, "title">, check: CheckDef): string {
  return tpl.replace(/\{resp\}/g, resp.title.trim()).replace(/\{check\}/g, check.label.toLowerCase());
}

export interface QuestionGap {
  gapType: GapType;
  claimIds?: readonly string[];
}

/**
 * Plain, specific question text from a template per check kind and gap type.
 * For conflicting gaps, values come only from claims the leaver may see (role set includes leaverRole).
 */
export function questionText(
  gap: QuestionGap,
  resp: Pick<Responsibility, "title" | "entities">,
  check: LacunaCheck,
  kind: ResponsibilityKind,
  leaverVisibleClaims: readonly Pick<Claim, "id" | "entity" | "attribute" | "value" | "state" | "roleSet">[],
  leaverRole: RoleKey,
): string {
  const missing = fill(
    check.question?.missing ?? MISSING_TEMPLATES[check.key] ?? WTAG_FALLBACK[check.wTag],
    resp,
    check,
  );
  if (gap.gapType === "missing") return missing;
  if (gap.gapType === "partial") {
    if (check.question?.partial) return fill(check.question.partial, resp, check);
    return `The record only partly answers this for ${KIND_NOUN[kind]}. ${missing}`;
  }
  // conflicting
  const cited = new Set(gap.claimIds ?? []);
  const values: string[] = [];
  for (const c of leaverVisibleClaims) {
    if (!c.roleSet.includes(leaverRole)) continue;
    const relevant = cited.size > 0
      ? cited.has(c.id)
      : c.state === "conflicting" && resp.entities.includes(c.entity) && check.attributes.includes(c.attribute);
    if (!relevant) continue;
    if (!values.some((v) => norm(v) === norm(c.value))) values.push(c.value);
  }
  if (values.length >= 2) {
    const [a, b] = values;
    return `Two people gave different answers for ${check.label.toLowerCase()} of ${resp.title.trim()}: "${a}" and "${b}". Which is right now, and since when?`;
  }
  return `People gave different answers for ${check.label.toLowerCase()} of ${resp.title.trim()}. Which is right now, and since when?`;
}

// ---------- answers ----------

/** The leaver may narrow an answer's role set, never widen it: the intersection, in base order. */
export function narrowRoleSet(base: readonly RoleKey[], requested?: readonly RoleKey[] | null): RoleKey[] {
  const uniqueBase = [...new Set(base)];
  if (!requested) return uniqueBase;
  const want = new Set(requested);
  return uniqueBase.filter((r) => want.has(r));
}

export interface AnsweredQuestion {
  id?: string;
  text: string;
  resp: Pick<Responsibility, "id" | "key" | "entities">;
  check: Pick<CheckDef, "key" | "attributes">;
  /** Role set the answer starts with (e.g. the pack's upload default). */
  roleSet: readonly RoleKey[];
  entityLabel?: string;
}

export interface AnswerOptions {
  leaverName?: string;
  /** ISO time of the answer; defaults to now. */
  ts?: string;
  sourceId?: string;
  workspaceId?: string;
  /** Roles the leaver wants to limit the answer to; intersected with the base set. */
  narrowTo?: readonly RoleKey[] | null;
}

export type AnswerSegment = Segment & { kind: "answer"; sourceKind: "interview" };

export interface AnswerClaimDraft {
  workspaceId: string;
  entity: string;
  entityLabel: string;
  attribute: Claim["attribute"];
  value: string;
  statement: string;
  citations: Citation[];
  trust: "leaver_said";
  state: "active";
  roleSet: RoleKey[];
  validFrom: string;
  authorId: string | null;
  sourceKinds: ["interview"];
  origin: "leaver_answer";
}

/** Segment id per ARCHITECTURE section 4: seg_ + 16 hex of sha256(kind|ts|thread|position|sha256(norm(text))). */
export function segmentId(sourceKind: string, ts: string, thread: string, position: number, text: string): string {
  return `seg_${sha256Hex(`${sourceKind}|${ts}|${thread}|${position}|${sha256Hex(norm(text))}`).slice(0, 16)}`;
}

/**
 * Turns a leaver's answer into an interview segment and a leaver_said claim draft.
 * The answer text must already be masked (Tether masking runs before storage).
 */
export function answerToDrafts(
  answerText: string,
  question: AnsweredQuestion,
  leaverPersonId: string | null,
  opts: AnswerOptions = {},
): { segment: AnswerSegment; claim: AnswerClaimDraft } {
  const text = answerText.trim();
  if (!text) throw new Error("An answer cannot be empty");
  const attribute = question.check.attributes[0];
  const entity = question.resp.entities[0];
  if (!attribute || !entity) throw new Error("The question has no attribute or entity to attach the answer to");

  const ts = opts.ts ?? new Date().toISOString();
  const thread = `interview:${question.resp.key}:${question.check.key}`;
  const roleSet = narrowRoleSet(question.roleSet, opts.narrowTo);
  const id = segmentId("interview", ts, thread, 0, text);
  const workspaceId = opts.workspaceId ?? "";

  const segment: AnswerSegment = {
    id,
    sourceId: opts.sourceId ?? "interview",
    sourceKind: "interview",
    kind: "answer",
    ts,
    authorId: leaverPersonId,
    thread,
    position: 0,
    text,
    textHash: sha256Hex(norm(text)),
    roleSet,
    version: 1,
    meta: {
      questionId: question.id ?? null,
      questionText: question.text,
      responsibilityId: question.resp.id,
      checkKey: question.check.key,
    },
  };

  const claim: AnswerClaimDraft = {
    workspaceId,
    entity,
    entityLabel: question.entityLabel ?? entity,
    attribute,
    value: text,
    statement: `${opts.leaverName ?? "The leaver"} said: ${text}`,
    citations: [{ segmentId: id, quote: text, accepted: true, exact: true }],
    trust: "leaver_said",
    state: "active",
    roleSet,
    validFrom: ts,
    authorId: leaverPersonId,
    sourceKinds: ["interview"],
    origin: "leaver_answer",
  };
  return { segment, claim };
}
