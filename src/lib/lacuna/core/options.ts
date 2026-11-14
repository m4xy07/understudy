// Ranked options (pure): possible answers for a gap that stays open. Leads, never answers.
// Contract: docs/ARCHITECTURE.md section 4, "Recovery". Options are not claims: they live only in
// recovery_steps, so the stand-in successor never sees them and they never change a score.
// The model may propose candidates; code checks every cited claim id, and code alone ranks.
import { z } from "zod";
import type { Attribute, Claim, CheckDef, Responsibility, RoleKey, SourceKind, Trust } from "@/lib/types";
import { norm } from "@/lib/text/norm";
import { recency } from "@/lib/tether/graph";
import type { LacunaCheck } from "./pack";
import { formatClaimLine, satisfies, type VisibleClaim } from "./standin";

export type OptionSource = "conflict" | "weak" | "pattern" | "model";

export interface OptionEvidence {
  claimId: string;
  segmentId: string | null;
  quote: string | null;
  authorId: string | null;
  ts: string;
  sourceKind: SourceKind | null;
  attribute: Attribute;
  trust: Trust;
  roleSet: RoleKey[];
}

export interface OptionCandidate {
  value: string;
  source: OptionSource;
  evidence: OptionEvidence[];
  /** Model proposals only: the model's one-line reason (shown as a muted note, never as fact). */
  why?: string;
}

export interface RankedOption {
  value: string;
  sources: OptionSource[];
  evidence: OptionEvidence[];
  score: number;
  why?: string;
  /** Who may see the option: the roles that can see every piece of its evidence. */
  roleSet: RoleKey[];
}

export const MAX_OPTIONS = 3;

const TRUST_WEIGHT: Record<Trust, number> = {
  from_record: 3, corroborated: 3, leaver_said: 2, successor_found: 2, second_hand: 1.5, inferred: 1, ranked_options: 0,
};

type OptionClaim = Pick<Claim, "id" | "entity" | "attribute" | "value" | "statement" | "state" | "trust" | "citations" | "authorId" | "validFrom" | "sourceKinds" | "roleSet">;

export function evidenceOf(c: OptionClaim): OptionEvidence {
  const cit = c.citations.find((x) => x.accepted !== false && x.quote) ?? c.citations.find((x) => x.accepted !== false) ?? c.citations[0];
  return {
    claimId: c.id,
    segmentId: cit?.segmentId ?? null,
    quote: cit?.quote ?? null,
    authorId: c.authorId,
    ts: c.validFrom,
    sourceKind: c.sourceKinds[0] ?? null,
    attribute: c.attribute,
    trust: c.trust,
    roleSet: [...c.roleSet],
  };
}

function onGap(c: Pick<Claim, "entity" | "attribute">, resp: Pick<Responsibility, "entities">, check: Pick<CheckDef, "attributes">): boolean {
  return resp.entities.includes(c.entity) && check.attributes.includes(c.attribute);
}

/** One candidate per distinct value among the conflicting claims on the gap. */
export function conflictOptions(
  resp: Pick<Responsibility, "entities">,
  check: Pick<CheckDef, "attributes">,
  claims: readonly OptionClaim[],
): OptionCandidate[] {
  return claims
    .filter((c) => c.state === "conflicting" && onGap(c, resp, check))
    .map((c) => ({ value: c.value, source: "conflict" as const, evidence: [evidenceOf(c)] }));
}

/** One candidate per active claim that satisfies the check with weak trust (a neighbour's answer, a trace). */
export function weakOptions(
  resp: Pick<Responsibility, "entities">,
  check: LacunaCheck,
  claims: readonly OptionClaim[],
  today?: string,
): OptionCandidate[] {
  return claims
    .filter((c) => c.state === "active" && (c.trust === "second_hand" || c.trust === "inferred") && resp.entities.includes(c.entity)
      && satisfies(c, check, today))
    .map((c) => ({ value: c.value, source: "weak" as const, evidence: [evidenceOf(c)] }));
}

/** For a check that needs a date: the next date a calendar cadence implies. */
export function patternOptions(
  resp: Pick<Responsibility, "entities">,
  check: LacunaCheck,
  patterns: readonly { entityKey: string; impliedNext?: string; claim: OptionClaim | null }[],
): OptionCandidate[] {
  if (!check.needsDate) return [];
  return patterns
    .filter((p) => p.impliedNext && p.claim && resp.entities.includes(p.entityKey))
    .map((p) => ({ value: p.impliedNext!, source: "pattern" as const, evidence: [evidenceOf(p.claim!)] }));
}

function intersect(sets: RoleKey[][], order: readonly RoleKey[]): RoleKey[] {
  if (sets.length === 0) return [];
  return order.filter((r) => sets.every((s) => s.includes(r)));
}

/**
 * Merge candidates with the same normalised value, then rank in code:
 *   score = Σ over evidence claims of trustWeight × authority(attribute, source kind) / 3 × recency
 *           + 0.5 × (distinct authors − 1)
 * Top 3 by score, ties by value. The model never ranks and never sets a label.
 */
export function rankOptions(
  candidates: readonly OptionCandidate[],
  authorityOf: (attribute: Attribute, sourceKind: SourceKind) => number,
  now: string,
  roleOrder: readonly RoleKey[],
): RankedOption[] {
  const merged = new Map<string, { value: string; sources: OptionSource[]; evidence: Map<string, OptionEvidence>; why?: string }>();
  for (const c of candidates) {
    const key = norm(c.value);
    if (!key || c.evidence.length === 0) continue;
    const m = merged.get(key) ?? { value: c.value.trim(), sources: [], evidence: new Map<string, OptionEvidence>() };
    if (!m.sources.includes(c.source)) m.sources.push(c.source);
    for (const e of c.evidence) if (!m.evidence.has(e.claimId)) m.evidence.set(e.claimId, e);
    if (c.why && !m.why) m.why = c.why;
    merged.set(key, m);
  }
  const out: RankedOption[] = [];
  for (const m of merged.values()) {
    const evidence = [...m.evidence.values()];
    const authors = new Set(evidence.map((e) => e.authorId).filter(Boolean));
    const score = evidence.reduce((sum, e) => {
      const auth = e.sourceKind ? authorityOf(e.attribute, e.sourceKind) : 1;
      return sum + TRUST_WEIGHT[e.trust] * (auth / 3) * recency(e.ts, now);
    }, 0) + 0.5 * Math.max(0, authors.size - 1);
    out.push({
      value: m.value,
      sources: m.sources,
      evidence,
      score: Math.round(score * 1000) / 1000,
      ...(m.why ? { why: m.why } : {}),
      roleSet: intersect(evidence.map((e) => e.roleSet), roleOrder),
    });
  }
  return out.sort((a, b) => b.score - a.score || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)).slice(0, MAX_OPTIONS);
}

// ---------- model proposals (M2) ----------

export const OptionsOutputSchema = z.object({
  options: z.array(z.object({
    answer: z.string(),
    claim_ids: z.array(z.string()),
    why: z.string(),
  })).max(MAX_OPTIONS),
});

export type OptionsOutput = z.infer<typeof OptionsOutputSchema>;

export const OPTIONS_JSON_SCHEMA_NAME = "recovery_options";
export const OPTIONS_JSON_SCHEMA = z.toJSONSchema(OptionsOutputSchema);

const OPTIONS_SYSTEM =
  "The person who knew the answer cannot be reached. From the claims listed, propose possible answers to the question. " +
  "Every answer must rest on at least one listed claim, cited by its ID. Never invent claim IDs and never add facts " +
  "that are not in the claims. If the claims do not point to any answer, return an empty list. Reply with JSON only.";

/**
 * The prompt for option proposals. It holds record claims only, in id order, so it is the same
 * text for the same record whatever people have answered since (cacheable).
 */
export function buildOptionsPrompt(
  resp: Pick<Responsibility, "key" | "title" | "kind">,
  check: Pick<CheckDef, "key" | "label" | "attributes">,
  question: string,
  claims: readonly VisibleClaim[],
): { system: string; user: string } {
  const lines = [...claims].sort((a, b) => (a.id < b.id ? -1 : 1)).map(formatClaimLine);
  const user = [
    `Responsibility ${resp.key}: ${resp.title} (${resp.kind.replace(/_/g, " ")})`,
    `Open check: ${check.label} (answered by ${check.attributes.join(" or ")})`,
    `Question: ${question}`,
    "",
    "Claims on record:",
    lines.length > 0 ? lines.join("\n") : "(no claims)",
    "",
    `Return {"options":[{"answer":"...","claim_ids":["..."],"why":"..."}]} with at most ${MAX_OPTIONS} options, best first. ` +
      "answer is short and concrete. why is one sentence. An empty list is a valid reply.",
    "/no_think",
  ].join("\n");
  return { system: OPTIONS_SYSTEM, user };
}

function contentWords(s: string): string[] {
  return norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
}

/**
 * Code-side check of the model's proposals. A proposal is dropped when it cites no known live
 * claim, or when fewer than half of its words of four letters or more appear in the cited claims.
 */
export function evaluateOptions(output: OptionsOutput, claimsById: ReadonlyMap<string, OptionClaim>): OptionCandidate[] {
  const out: OptionCandidate[] = [];
  for (const o of output.options.slice(0, MAX_OPTIONS)) {
    const answer = o.answer.trim();
    if (!answer) continue;
    const cited = [...new Set(o.claim_ids)]
      .map((id) => claimsById.get(id))
      .filter((c): c is OptionClaim => !!c && (c.state === "active" || c.state === "conflicting"));
    if (cited.length === 0) continue;
    const words = contentWords(answer);
    const haystack = new Set(cited.flatMap((c) => contentWords(`${c.value} ${c.statement}`)));
    const grounded = words.filter((w) => haystack.has(w)).length;
    if (words.length > 0 && grounded * 2 < words.length) continue;
    out.push({ value: answer.slice(0, 300), source: "model", evidence: cited.map(evidenceOf), why: o.why.trim().slice(0, 300) || undefined });
  }
  return out;
}
