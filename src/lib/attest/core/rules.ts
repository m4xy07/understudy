// Attest rules: corroboration, supersession / conflicts, importance and review tier.
// Contract: docs/ARCHITECTURE.md section 4 "Claims (Attest)" and "Review and Handover (Relay)".
// Pure functions: inputs are never mutated; each returns new Claim objects.
import type {
  Attribute,
  Claim,
  Importance,
  ResponsibilityKind,
  ReviewTier,
  Segment,
  SourceKind,
  Trust,
} from "@/lib/types";
import { MULTI_VALUED, type RoleKey } from "@/lib/types";
import { norm } from "@/lib/text/norm";
import type { AttestPack } from "./verify";
import { isPersonOrigin } from "./origins";
import { contentTokens, isOptionsValue, locationKind, sameEvent } from "./consolidate";

/** One supersession/conflict decision, for the claim_events audit log. */
export interface RuleFiring {
  rule: 1 | 2 | 3 | 4;
  olderId: string;   // rules 1-2: the superseded claim; rules 3-4: the older side of the conflict
  newerId: string;   // rules 1-2: the claim that wins; rules 3-4: the newer side
}

// ---------------------------------------------------------------------------------------------
// Labels used in state notes (plain words, shown in the UI).

const KIND_OWNER: Record<SourceKind, { name: string; verb: string }> = {
  tasks_csv: { name: "the task board", verb: "owns" },
  ics: { name: "the calendar", verb: "owns" },
  markdown: { name: "the notes", verb: "own" },
  github: { name: "the code repository", verb: "owns" },
  slack: { name: "Slack", verb: "owns" },
  whatsapp: { name: "WhatsApp", verb: "owns" },
  interview: { name: "the leaver's answers", verb: "own" },
  finding: { name: "the successor's findings", verb: "own" },
};

const KIND_ITEM: Record<SourceKind, string> = {
  tasks_csv: "the task board",
  ics: "the calendar",
  markdown: "a note",
  github: "a GitHub record",
  slack: "a Slack message",
  whatsapp: "a WhatsApp message",
  interview: "the leaver's answer",
  finding: "a successor finding",
};

const ATTR_PLURAL: Record<Attribute, string> = {
  owner: "owners", status: "status", deadline: "deadlines", location: "locations",
  procedure: "procedures", access: "access", decision: "decisions", reason: "reasons",
  dependency: "dependencies", contact: "contacts", risk: "risks",
};

export const CONFLICT_NOTE = "Conflicting: two people disagree and no rule settles it. Ask a person.";

const day = (iso: string) => iso.slice(0, 10);

function timeOf(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

// ---------------------------------------------------------------------------------------------
// Authority

/** Max authority over the claim's source kinds, from pack.sourceAuthority[attribute]. */
export function authorityOf(claim: Pick<Claim, "attribute" | "sourceKinds">, pack: Pick<AttestPack, "sourceAuthority">): number {
  const table = pack.sourceAuthority[claim.attribute] ?? {};
  let best = 0;
  for (const k of claim.sourceKinds) best = Math.max(best, table[k] ?? 0);
  return best;
}

/** The claim's source kind with the highest authority for its attribute (for notes). */
function topKind(claim: Claim, pack: Pick<AttestPack, "sourceAuthority">): SourceKind {
  const table = pack.sourceAuthority[claim.attribute] ?? {};
  let best: SourceKind = claim.sourceKinds[0] ?? "interview";
  for (const k of claim.sourceKinds) if ((table[k] ?? 0) > (table[best] ?? 0)) best = k;
  return best;
}

function sameAuthor(a: Claim, b: Claim): boolean {
  return a.authorId != null && a.authorId === b.authorId;
}

function replyTargets(seg: Segment): string[] {
  const out: string[] = [];
  for (const key of ["replyTo", "quotes", "quotedSegmentId"]) {
    const v = seg.meta?.[key];
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
  }
  return out;
}

/** True when a segment cited by `newer` replies to / quotes a segment cited by `older`. */
export function repliesTo(newer: Claim, older: Claim, segmentsById?: Map<string, Segment>): boolean {
  if (!segmentsById) return false;
  const olderSegs = new Set(older.citations.filter((c) => c.accepted).map((c) => c.segmentId));
  for (const c of newer.citations) {
    if (!c.accepted) continue;
    const seg = segmentsById.get(c.segmentId);
    if (seg && replyTargets(seg).some((id) => olderSegs.has(id))) return true;
  }
  return false;
}

/** True when either claim's cited segments reply to / quote the other's. */
function linked(a: Claim, b: Claim, segmentsById?: Map<string, Segment>): boolean {
  return repliesTo(a, b, segmentsById) || repliesTo(b, a, segmentsById);
}

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const DATE_LIKE = new RegExp(
  `^\\d{4}-\\d{2}-\\d{2}|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}\\b`,
  "i",
);
const CADENCE = /\b(every|each|once|weekly|monthly|yearly|annually|daily|per (?:term|year|month|week)|repeats?)\b/i;

const MONTHS3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "YYYY-MM-DD" for an ISO value, "MM-DD" for "8 Aug ..." / "Aug 8 ...", else null. */
function dayOf(v: string): string | null {
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  if (iso) return iso[1];
  const pad = (n: string) => n.padStart(2, "0");
  let m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})`, "i").exec(v);
  if (m) return `${pad(String(MONTHS3.indexOf(m[2].slice(0, 3).toLowerCase()) + 1))}-${pad(m[1])}`;
  m = new RegExp(`\\b(${MONTH})\\s+(\\d{1,2})\\b`, "i").exec(v);
  if (m) return `${pad(String(MONTHS3.indexOf(m[1].slice(0, 3).toLowerCase()) + 1))}-${pad(m[2])}`;
  return null;
}

/** A single calendar day ("2026-12-19", "19 Dec", "Dec 19"), not a cadence ("every year, next ..."). */
export function isDateValue(v: string): boolean {
  return DATE_LIKE.test(v) && !CADENCE.test(v);
}

/**
 * Two claims on the same entity and single-valued attribute are only compared when their
 * values are the same KIND of fact, so that a cadence never "conflicts" with a due date and a
 * verify step never "supersedes" the deploy steps:
 * - values where one contains the other agree (a name, and the same name with a title after it);
 * - deadline: both values are single dates (a cadence such as "once per term" is another fact);
 * - deadline, location: only values about the same event ("2026-08-02 (stall)" names its event;
 *   see ./consolidate), so the date of one event never conflicts with the date of another;
 * - owner: always; location: only the same kind of location (a room and a repo path are two facts);
 * - never: a folded list of options ("Options: A or B"), which states no single value;
 * - procedure, status, decision: only a restatement. A reply / quote link between the cited
 *   segments always counts. The same author counts when one side is a board or calendar field;
 *   for two pieces of prose only when the values share a content word (they are about the same
 *   thing) and the newer one is not from a source with less authority (prose in a weaker source
 *   is another facet, not a correction);
 * - never: two structured rows (two board cards are two items), claims sharing a cited segment,
 *   or one person's statements made at the same moment;
 * - risk, access: never (several risks or credential names per entity are normal).
 */
export function comparable(
  a: Claim,
  b: Claim,
  segmentsById?: Map<string, Segment>,
  pack?: Pick<AttestPack, "sourceAuthority">,
): boolean {
  const strip = (v: string) => norm(v).replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, " ").trim();
  const va = strip(a.value);
  const vb = strip(b.value);
  if (!va || !vb || va === vb || va.includes(vb) || vb.includes(va)) return false;
  // Two board rows / calendar events are two different items, not two versions of one.
  if (a.origin === "structured" && b.origin === "structured") return false;
  // One segment listing several facts (chosen and rejected options) does not contradict itself,
  // nor does one person's two statements made at the same moment.
  const segsA = new Set(a.citations.filter((c) => c.accepted).map((c) => c.segmentId));
  if (b.citations.some((c) => c.accepted && segsA.has(c.segmentId))) return false;
  if (sameAuthor(a, b) && timeOf(a.validFrom) === timeOf(b.validFrom)) return false;
  if (isOptionsValue(a.value) || isOptionsValue(b.value)) return false;
  switch (a.attribute) {
    case "deadline": {
      if (!isDateValue(a.value) || !isDateValue(b.value)) return false;
      if (!sameEvent(a.value, b.value)) return false;
      const da = dayOf(a.value);
      const db = dayOf(b.value);
      const md = (d: string) => (d.length === 10 ? d.slice(5) : d);
      if (da && db && md(da) === md(db) && (da.length === 5 || db.length === 5 || da === db)) return false; // same day
      // A date already past when the other claim was made is an earlier occurrence, not a rival.
      if (da?.length === 10 && da < b.validFrom.slice(0, 10)) return false;
      if (db?.length === 10 && db < a.validFrom.slice(0, 10)) return false;
      return true;
    }
    case "owner":
      return true;
    case "location":
      return sameEvent(a.value, b.value) && locationKind(a.value) === locationKind(b.value);
    case "procedure":
    case "status":
    case "decision": {
      if (linked(a, b, segmentsById)) return true;
      if (!sameAuthor(a, b)) return false;
      if (a.origin === "structured" || b.origin === "structured") return true;
      const ta = contentTokens(a.value);
      const tb = new Set(contentTokens(b.value));
      if (!ta.some((t) => tb.has(t))) return false;
      if (!pack) return true;
      const [older, newer] = timeOf(a.validFrom) <= timeOf(b.validFrom) ? [a, b] : [b, a];
      return authorityOf(newer, pack) >= authorityOf(older, pack);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Supersession and conflicts (single-valued attributes only)

interface Win { by: Claim; rule: 1 | 2; linked: boolean }
interface Clash { older: Claim; newer: Claim; rule: 3 | 4 }

/**
 * Apply the four rules of section 4 to every pair of claims on the same entity and single-valued
 * attribute with different normalised values. States are recomputed from scratch (idempotent):
 * dropped and reviewer-rejected claims are left untouched. A claim superseded by any rule is
 * `superseded` (pointing at its newest winner); a conflict counts only while neither side is
 * superseded. Timestamps alone never settle a disagreement between two people.
 */
export function applySupersession(
  claims: Claim[],
  pack: Pick<AttestPack, "sourceAuthority">,
  segmentsById?: Map<string, Segment>,
): { claims: Claim[]; firings: RuleFiring[] } {
  const out = claims.map((c) => ({ ...c }));
  const candidates = out.filter((c) => c.state !== "dropped" && c.review !== "rejected");
  for (const c of candidates) {
    c.state = "active";
    c.stateNote = null;
    c.supersededBy = null;
  }

  const groups = new Map<string, Claim[]>();
  for (const c of candidates) {
    if (MULTI_VALUED.includes(c.attribute)) continue;
    if (c.entity === "other") continue; // "other" is not one entity: never compare across it
    const key = `${c.entity}\u0000${c.attribute}`;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }

  const wins = new Map<string, Win>();
  const clashes: Clash[] = [];
  const recordWin = (loser: Claim, by: Claim, rule: 1 | 2, linked = false) => {
    const prev = wins.get(loser.id);
    if (
      !prev ||
      timeOf(by.validFrom) > timeOf(prev.by.validFrom) ||
      (timeOf(by.validFrom) === timeOf(prev.by.validFrom) && authorityOf(by, pack) > authorityOf(prev.by, pack))
    ) {
      wins.set(loser.id, { by, rule, linked });
    }
  };

  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => timeOf(a.validFrom) - timeOf(b.validFrom) || (a.id < b.id ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]; // older (or same time)
        const b = sorted[j]; // newer (or same time)
        if (norm(a.value) === norm(b.value)) continue;
        if (!comparable(a, b, segmentsById, pack)) continue;
        const aa = authorityOf(a, pack);
        const ab = authorityOf(b, pack);
        if (timeOf(a.validFrom) === timeOf(b.validFrom)) {
          // No order in time: only authority can settle it.
          if (ab > aa) recordWin(a, b, 1);
          else if (aa > ab) recordWin(b, a, 1);
          else clashes.push({ older: a, newer: b, rule: 3 });
          continue;
        }
        if (ab > aa) {
          recordWin(a, b, 1); // rule 1
        } else if (ab === aa) {
          const linked = repliesTo(b, a, segmentsById);
          if (sameAuthor(a, b) || linked) recordWin(a, b, 2, linked && !sameAuthor(a, b)); // rule 2
          else clashes.push({ older: a, newer: b, rule: 3 }); // rule 3
        } else {
          clashes.push({ older: a, newer: b, rule: 4 }); // rule 4
        }
      }
    }
  }

  const firings: RuleFiring[] = [];
  const byId = new Map(out.map((c) => [c.id, c]));

  for (const [loserId, win] of wins) {
    const loser = byId.get(loserId)!;
    loser.state = "superseded";
    loser.supersededBy = win.by.id;
    if (win.rule === 1) {
      const owner = KIND_OWNER[topKind(win.by, pack)];
      loser.stateNote = `Superseded: ${owner.name} ${owner.verb} ${ATTR_PLURAL[loser.attribute]} (updated on ${day(win.by.validFrom)})`;
    } else {
      loser.stateNote = win.linked
        ? `Superseded: a reply updated it on ${day(win.by.validFrom)}`
        : `Superseded: the same person updated it on ${day(win.by.validFrom)}`;
    }
    firings.push({ rule: win.rule, olderId: loserId, newerId: win.by.id });
  }

  // Note priority when a claim is in several conflicts: rule-4 newer > rule 3 > rule-4 older.
  const notePriority = new Map<string, number>();
  const setNote = (c: Claim, note: string, priority: number) => {
    if ((notePriority.get(c.id) ?? -1) < priority) {
      c.stateNote = note;
      notePriority.set(c.id, priority);
    }
  };
  for (const { older, newer, rule } of clashes) {
    if (wins.has(older.id) || wins.has(newer.id)) continue;
    older.state = "conflicting";
    newer.state = "conflicting";
    if (rule === 3) {
      setNote(older, CONFLICT_NOTE, 2);
      setNote(newer, CONFLICT_NOTE, 2);
    } else {
      const owner = KIND_OWNER[topKind(older, pack)];
      const plural = ATTR_PLURAL[older.attribute];
      setNote(
        newer,
        `Possibly outdated owner: ${owner.name} ${owner.verb} ${plural}, but ${KIND_ITEM[topKind(newer, pack)]} from ${day(newer.validFrom)} disagrees. Ask a person.`,
        3,
      );
      setNote(
        older,
        `Conflicting: ${KIND_ITEM[topKind(newer, pack)]} from ${day(newer.validFrom)} disagrees with this. Ask a person.`,
        1,
      );
    }
    firings.push({ rule, olderId: older.id, newerId: newer.id });
  }

  return { claims: out, firings };
}

// ---------------------------------------------------------------------------------------------
// Corroboration

// A person's word that a record once corroborated is still not a record: it can never upgrade
// another person's word (no laundering through a second finding or a leaver answer).
const isRecord = (c: Claim) =>
  (c.trust === "from_record" || c.trust === "corroborated") && c.supportCheck !== "no" && !isPersonOrigin(c.origin);
// A person's word (a leaver answer, a successor finding) is upgraded only by a record that agrees:
// two findings, or a finding and a leaver answer, never upgrade each other (see corroborate()).
const UPGRADEABLE: readonly Trust[] = ["from_record", "leaver_said", "successor_found", "inferred"];
const isUpgradeable = (c: Claim) => UPGRADEABLE.includes(c.trust) && c.supportCheck !== "no";

function kindsKey(c: Claim): string {
  return [...new Set(c.sourceKinds)].sort().join(",");
}

/** Independent agreement: different source kinds, or two known and different authors. */
export function independent(a: Claim, b: Claim): boolean {
  const differentAuthors = a.authorId != null && b.authorId != null && a.authorId !== b.authorId;
  return kindsKey(a) !== kindsKey(b) || differentAuthors;
}

/**
 * Two active claims with the same entity + attribute + norm(value) that agree independently
 * become `corroborated`, but only when at least one side is a record (from_record or
 * corroborated). The other side may be a record, a leaver answer (leaver_said) or inferred:
 * a leaver's word stays leaver_said until a record agrees. Claims the support check rejected,
 * second-hand and ranked options never take part.
 */
export function corroborate(claims: Claim[]): Claim[] {
  const out = claims.map((c) => ({ ...c }));
  const groups = new Map<string, Claim[]>();
  for (const c of out) {
    if (c.state !== "active" || c.review === "rejected") continue;
    if (!isRecord(c) && !isUpgradeable(c)) continue;
    const key = `${c.entity}\u0000${c.attribute}\u0000${norm(c.value)}`;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }
  const upgrade = new Set<Claim>();
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i];
        const b = g[j];
        if (!independent(a, b)) continue;
        if (!isRecord(a) && !isRecord(b)) continue;
        upgrade.add(a);
        upgrade.add(b);
      }
    }
  }
  for (const c of upgrade) if (c.trust !== "corroborated") c.trust = "corroborated";
  return out;
}

// ---------------------------------------------------------------------------------------------
// Importance and review tier

export type EntityKinds =
  | Map<string, ResponsibilityKind | ResponsibilityKind[]>
  | Record<string, ResponsibilityKind | ResponsibilityKind[]>;

function kindsForEntity(
  entity: string,
  pack: Pick<AttestPack, "roleTemplates">,
  entityKinds?: EntityKinds,
): ResponsibilityKind[] {
  if (entityKinds) {
    const v = entityKinds instanceof Map ? entityKinds.get(entity) : entityKinds[entity];
    if (v) return Array.isArray(v) ? v : [v];
  }
  const kinds = new Set<ResponsibilityKind>();
  for (const list of Object.values(pack.roleTemplates ?? {})) {
    for (const t of list ?? []) if (t.entities.includes(entity)) kinds.add(t.kind);
  }
  return [...kinds];
}

/**
 * Importance from the pack checklists: the highest weight among checks (of the entity's
 * responsibility kinds) that this claim's attribute can satisfy. 5 -> blocking, 3 -> important.
 * The entity's kind comes from `entityKinds` when given, else from the pack's role templates.
 */
export function importanceOf(
  claim: Pick<Claim, "entity" | "attribute">,
  pack: Pick<AttestPack, "checklists" | "roleTemplates">,
  entityKinds?: EntityKinds,
): Importance {
  let w = 0;
  for (const kind of kindsForEntity(claim.entity, pack, entityKinds)) {
    for (const check of pack.checklists?.[kind] ?? []) {
      if (check.attributes.includes(claim.attribute)) w = Math.max(w, check.weight);
    }
  }
  return w >= 5 ? "blocking" : w >= 3 ? "important" : "normal";
}

/** Anything a bulk approver should not wave through. */
export function reviewFlags(claim: Claim): string[] {
  const flags: string[] = [];
  if (claim.state !== "active") flags.push(`state ${claim.state}`);
  if (claim.supportCheck === "partly" || claim.supportCheck === "no") flags.push(`support check ${claim.supportCheck}`);
  if (claim.citations.some((c) => !c.accepted)) flags.push("rejected citation");
  if (!claim.citations.some((c) => c.accepted && c.exact)) flags.push("no exact quote");
  // A claim that began as a finding is reviewed one by one, even after a record corroborates it.
  if (claim.origin === "successor_finding") flags.push("from a successor finding");
  return flags;
}

/** Sensitive: hidden from at least one role the pack flags as restricted audience ("sees least"). */
export function isSensitive(roleSet: readonly RoleKey[], restrictedAudience: readonly RoleKey[]): boolean {
  return restrictedAudience.some((r) => !roleSet.includes(r));
}

/**
 * Tier C: sensitive (hidden from a restricted audience role), conflicting, or blocking importance.
 * Tier A: corroborated, normal importance, no flags (bulk approve). Tier B: everything else.
 */
export function tierOf(claim: Claim, restrictedAudience: readonly RoleKey[]): ReviewTier {
  if (isSensitive(claim.roleSet, restrictedAudience) || claim.state === "conflicting" || claim.importance === "blocking") return "C";
  if (claim.trust === "corroborated" && claim.importance === "normal" && reviewFlags(claim).length === 0) return "A";
  return "B";
}

export function assignImportanceAndTier(
  claims: Claim[],
  pack: Pick<AttestPack, "checklists" | "roleTemplates" | "restrictedAudience">,
  entityKinds?: EntityKinds,
): Claim[] {
  return claims.map((c) => {
    const withImportance = { ...c, importance: importanceOf(c, pack, entityKinds) };
    return { ...withImportance, tier: tierOf(withImportance, pack.restrictedAudience) };
  });
}

// ---------------------------------------------------------------------------------------------
// All rules, in order: supersession/conflicts, then corroboration among active claims, then tiers.

export function applyRules(
  claims: Claim[],
  pack: AttestPack,
  opts: { segmentsById?: Map<string, Segment>; entityKinds?: EntityKinds } = {},
): { claims: Claim[]; firings: RuleFiring[] } {
  const { claims: ruled, firings } = applySupersession(claims, pack, opts.segmentsById);
  const corroborated = corroborate(ruled);
  return { claims: assignImportanceAndTier(corroborated, pack, opts.entityKinds), firings };
}
