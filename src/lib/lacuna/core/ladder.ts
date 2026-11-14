// The recovery ladder (pure): who may be asked, what an answer may be seen by, how a trace
// becomes a claim, and how the before and after panel is worked out.
// Contract: docs/ARCHITECTURE.md section 4, "Recovery". No database, no model.
import type {
  CheckDef, CheckResult, Claim, Coverage, Responsibility, ResponsibilityKind, RoleKey, Scores,
} from "@/lib/types";
import type { DraftClaim } from "@/lib/attest/core/verify";
import type { NeighbourCounts, NeighbourScore } from "@/lib/tether/graph";
import type { Trace } from "@/lib/tether/traces";
import { strongestTrust, gapKey, type LacunaCheck } from "./pack";
import {
  answerToDrafts, narrowRoleSet, questionText, segmentId, type AnswerOptions, type AnswerSegment, type AnsweredQuestion,
  type QuestionGap,
} from "./questions";
import { computeScores, type ScoredRun } from "./scores";
import { deterministicStandin, type ClaimMeta, type ClaimMetaIndex, type VisibleClaim } from "./standin";

export const MAX_NEIGHBOURS = 3;
export const MAX_NO_SEAT = 2;

function metaEntries(index: ClaimMetaIndex): [string, ClaimMeta][] {
  return index instanceof Map ? [...index.entries()] : Object.entries(index as Record<string, ClaimMeta>);
}

// ---------- access ----------

/**
 * "No access" has one definition. A role is walled off from a gap when any live claim (active or
 * conflicting) that could satisfy the check is hidden from that role. Decided from claim
 * metadata only (ids, attributes, states, role sets), never from row content.
 */
export function accessFor(
  resp: Pick<Responsibility, "entities">,
  check: Pick<CheckDef, "attributes">,
  role: RoleKey,
  meta: ClaimMetaIndex,
): "open" | "walled" {
  for (const [, m] of metaEntries(meta)) {
    if (m.state !== "active" && m.state !== "conflicting") continue;
    if (!resp.entities.includes(m.entity)) continue;
    if (!check.attributes.includes(m.attribute)) continue;
    if (!m.roleSet.includes(role)) return "walled";
  }
  return "open";
}

/** The roles that are not walled off from this gap, in the order given. */
export function openRoles(
  resp: Pick<Responsibility, "entities">,
  check: Pick<CheckDef, "attributes">,
  roles: readonly RoleKey[],
  meta: ClaimMetaIndex,
): RoleKey[] {
  return roles.filter((r) => accessFor(resp, check, r, meta) === "open");
}

// ---------- rung 1: who is asked ----------

export interface HolderIndex {
  /** node person id -> the roles that person holds */
  byPerson: ReadonlyMap<string, readonly RoleKey[]>;
}

export type NeighbourStatus = "asked" | "skipped_no_access" | "skipped_no_seat";

export interface NeighbourPlan {
  personId: string;
  role: RoleKey | null;
  status: NeighbourStatus;
  score: number;
  counts: NeighbourCounts;
  segmentIds: string[];
  /** Intersection of the role sets of the segments behind the score. */
  roleSet: RoleKey[];
}

/**
 * Route the scored people of one gap. A person who holds the leaver role is not a candidate.
 * A person with no role cannot be asked inside the app (shown, not asked). A person whose role
 * is walled off from the gap is skipped. Everyone else is asked. At most three role holders and
 * two people without a role, best score first; people without a role who share a display name
 * collapse to the best one.
 */
export function routeCandidates(
  scores: readonly NeighbourScore[],
  holders: HolderIndex,
  resp: Pick<Responsibility, "entities">,
  check: Pick<CheckDef, "attributes">,
  meta: ClaimMetaIndex,
  leaverRole: RoleKey,
  nameOf: (personId: string) => string = (id) => id,
): NeighbourPlan[] {
  const out: NeighbourPlan[] = [];
  let seated = 0;
  const noSeatNames = new Set<string>();
  for (const s of scores) {
    const roles = holders.byPerson.get(s.personId) ?? [];
    if (roles.includes(leaverRole)) continue;
    const base = { personId: s.personId, score: s.score, counts: s.counts, segmentIds: s.segmentIds, roleSet: s.roleSet };
    if (roles.length === 0) {
      const name = nameOf(s.personId).trim().toLowerCase();
      if (noSeatNames.has(name) || noSeatNames.size >= MAX_NO_SEAT) continue;
      noSeatNames.add(name);
      out.push({ ...base, role: null, status: "skipped_no_seat" });
      continue;
    }
    if (seated >= MAX_NEIGHBOURS) continue;
    seated += 1;
    const open = roles.find((r) => accessFor(resp, check, r, meta) === "open");
    out.push(open ? { ...base, role: open, status: "asked" } : { ...base, role: roles[0], status: "skipped_no_access" });
  }
  return out;
}

/** Who may read a neighbour row: the roles that can see every segment behind it and are not walled off. */
export function neighbourRowRoleSet(scoreRoleSet: readonly RoleKey[], open: readonly RoleKey[]): RoleKey[] {
  return scoreRoleSet.filter((r) => open.includes(r));
}

// The leaver's question templates speak to the leaver ("once you have left"). A neighbour gets
// the same question about the leaver instead.
const NEIGHBOUR_MISSING: Record<string, string> = {
  owner: "Who decides {resp} now that {leaver} cannot be reached?",
  last_state: "Where did {leaver} leave {resp}: what is done and what is not?",
  last_interaction: "When did {leaver} last talk to them about {resp}, and what was agreed?",
};

/**
 * The question as a neighbour sees it. Built from claims the neighbour's role may see, so a
 * conflicting question quotes only values that role can read.
 */
export function neighbourQuestionText(
  gap: QuestionGap,
  resp: Pick<Responsibility, "title" | "entities">,
  check: LacunaCheck,
  kind: ResponsibilityKind,
  visibleToNeighbour: readonly Pick<Claim, "id" | "entity" | "attribute" | "value" | "state" | "roleSet">[],
  neighbourRole: RoleKey,
  leaverName: string,
): string {
  const own = NEIGHBOUR_MISSING[check.key];
  const adapted: LacunaCheck = own && !check.question?.missing
    ? { ...check, question: { ...check.question, missing: own.replace(/\{leaver\}/g, leaverName || "the leaver") } }
    : check;
  return questionText(gap, resp, adapted, kind, visibleToNeighbour, neighbourRole);
}

// ---------- rung 1: answers ----------

/**
 * The role set a neighbour's answer starts with: the base (the pack's upload default) cut down to
 * the roles that can already see every live record on the topic that the neighbour can see. The
 * neighbour may narrow it further, never widen it. `keep` (the neighbour's role and the approver)
 * always stays.
 */
export function defaultAnswerRoleSet(
  base: readonly RoleKey[],
  resp: Pick<Responsibility, "entities">,
  check: Pick<CheckDef, "attributes">,
  visibleToNeighbour: readonly Pick<Claim, "entity" | "attribute" | "state" | "roleSet">[],
  keep: readonly RoleKey[] = [],
): RoleKey[] {
  const sets = visibleToNeighbour
    .filter((c) => (c.state === "active" || c.state === "conflicting") && resp.entities.includes(c.entity) && check.attributes.includes(c.attribute))
    .map((c) => c.roleSet);
  return [...new Set(base)].filter((r) => keep.includes(r) || sets.every((s) => s.includes(r)));
}

/** Narrow a default answer role set to what the neighbour ticked; `keep` always stays. Never wider than `base`. */
export function narrowAnswerRoleSet(base: readonly RoleKey[], requested: readonly RoleKey[] | null | undefined, keep: readonly RoleKey[]): RoleKey[] {
  if (!requested || requested.length === 0) return [...new Set(base)];
  return narrowRoleSet(base, [...requested, ...keep]);
}

const NO_ANSWER = [
  /^(i\s+)?(really\s+)?(do\s*n[o'’]?t|dont)\s+know\b/,
  /^no\s+idea\b/,
  /^no\s+clue\b/,
  /^not\s+sure\b/,
  /^idk\b/,
  /^(i\s+)?can(no|'|’)?t\s+say\b/,
  /^nothing\s+to\s+add\b/,
  /^n\/?a$/,
  /^unknown$/,
];

/** "I don't know", "no idea", "not sure, ask someone": a short non-answer is a decline, not evidence. */
export function looksLikeNoAnswer(text: string): boolean {
  const t = (text ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return true;
  if (t.length > 60) return false;
  return NO_ANSWER.some((re) => re.test(t));
}

export interface NeighbourAnswerClaim {
  workspaceId: string;
  entity: string;
  entityLabel: string;
  attribute: Claim["attribute"];
  value: string;
  statement: string;
  citations: Claim["citations"];
  trust: "second_hand";
  state: "active";
  roleSet: RoleKey[];
  validFrom: string;
  authorId: string | null;
  sourceKinds: ["interview"];
  origin: "neighbour_answer";
}

/**
 * A neighbour's answer as an answer segment and a Second-hand claim draft. Same shape as a leaver
 * answer, with its own thread (recovery:<responsibility>:<check>:<person>), so for a fixed
 * timestamp the segment id depends only on who answered what with which text.
 */
export function neighbourAnswerToDrafts(
  answerText: string,
  question: AnsweredQuestion,
  person: { id: string | null; name: string },
  opts: AnswerOptions = {},
): { segment: AnswerSegment; claim: NeighbourAnswerClaim } {
  const { segment: base, claim } = answerToDrafts(answerText, question, person.id, opts);
  const thread = `recovery:${question.resp.key}:${question.check.key}:${person.id ?? "unknown"}`;
  const id = segmentId("interview", base.ts, thread, 0, base.text);
  const segment: AnswerSegment = { ...base, id, thread, meta: { ...base.meta, recovery: true, answeredBy: person.id } };
  return {
    segment,
    claim: {
      workspaceId: claim.workspaceId,
      entity: claim.entity,
      entityLabel: claim.entityLabel,
      attribute: claim.attribute,
      value: claim.value,
      statement: `${person.name || "A colleague"} said (second-hand): ${base.text}`,
      citations: [{ segmentId: id, quote: base.text, accepted: true, exact: true }],
      trust: "second_hand",
      state: "active",
      roleSet: claim.roleSet,
      validFrom: claim.validFrom,
      authorId: person.id,
      sourceKinds: ["interview"],
      origin: "neighbour_answer",
    },
  };
}

// ---------- rung 2: traces ----------

const MAX_STATEMENT = 700;

/** A trace as a draft for Attest's verifier: one citation per step, quote or null. */
export function traceToDraft(trace: Trace): DraftClaim {
  const citations = trace.steps.flatMap((s) => s.citations.map((c) => ({ segment_id: c.segmentId, quote: c.quote })));
  const ids = [...new Set(citations.map((c) => c.segment_id))];
  const body = trace.steps.map((s) => `${s.n}. ${s.text}`).join(" ");
  const statement = `Rebuilt from ${trace.sourceLabel}: ${body}`;
  return {
    entity: trace.entityKey,
    attribute: trace.attribute,
    value: trace.value,
    statement: statement.length > MAX_STATEMENT ? `${statement.slice(0, MAX_STATEMENT - 1)}…` : statement,
    citations,
    batchId: trace.id,
    batchSegmentIds: ids,
    origin: "structured",
  };
}

/**
 * Would a claim built from a trace answer this check? Only when the stand-in's deterministic
 * reading of that one claim gives Partial: a cadence without an upcoming date cannot serve a
 * "next due date" check. A check that asks who is never served by files and history.
 */
export function traceServes(
  candidate: VisibleClaim,
  resp: Pick<Responsibility, "id" | "entities">,
  check: LacunaCheck,
  role: RoleKey,
  today?: string,
): boolean {
  if (check.wTag === "WHO") return false;
  const [r] = deterministicStandin(resp, [check], [candidate], {}, role, today);
  return r.coverage === "partial";
}

// ---------- the before and after panel ----------

export type GapState = "closed" | "partly" | "open";

export function gapState(coverage: Coverage | undefined): GapState {
  return coverage === "covered" ? "closed" : coverage === "partial" ? "partly" : "open";
}

export interface LadderSummary {
  worked: number;
  closed: number;
  partly: number;
  open: number;
}

/** Closed means Covered in the given run; partly means Partial; everything else is still open. */
export function ladderSummary(gapKeys: ReadonlySet<string>, results: readonly CheckResult[]): LadderSummary {
  const byKey = new Map(results.map((r) => [gapKey(r.responsibilityId, r.checkKey), r]));
  const out: LadderSummary = { worked: gapKeys.size, closed: 0, partly: 0, open: 0 };
  for (const k of gapKeys) {
    const state = gapState(byKey.get(k)?.coverage);
    if (state === "closed") out.closed += 1;
    else if (state === "partly") out.partly += 1;
    else out.open += 1;
  }
  return out;
}

/**
 * The upper bound if the leaver answered every ladder gap: each becomes Covered with the stronger
 * of its current best trust and "Leaver said", then the usual scoring runs. No model.
 */
export function projectLeaverRun(
  baseline: ScoredRun,
  gapKeys: ReadonlySet<string>,
  checksByResp: Record<string, readonly CheckDef[]>,
  namedOwners: ReadonlySet<string> = new Set(),
): { scores: Scores; results: CheckResult[] } {
  const results = baseline.results.map((r): CheckResult => {
    if (!gapKeys.has(gapKey(r.responsibilityId, r.checkKey))) return r;
    return { ...r, coverage: "covered", bestTrust: strongestTrust([...(r.bestTrust ? [r.bestTrust] : []), "leaver_said"]), note: "" };
  });
  return { scores: computeScores(results, checksByResp, namedOwners), results };
}
