// Content-level confidentiality: decide from what a segment says who may see it.
// Contract: docs/ARCHITECTURE.md section 4a, docs/round3/specs/02_confidentiality.md section 5.
//
// Two stages, both before the first write of a role set:
//   1. Rules (pure, synchronous): strong hits limit the segment; weak hits make it borderline.
//   2. Model, borderline segments only: it answers one of four enum labels per segment id.
//      It can narrow a segment or leave it alone. It cannot widen and it never sees a strong hit.
// Fail closed: a borderline segment the model could not be asked about is held (limited to the
// candidate categories) until the approver decides.
// Narrowing never adds a role: the new role set is the current one cut down to the roles the pack
// allows for the category. This module names no role: the lists come from the pack.
import { z } from "zod";
import type { CallResult } from "@/lib/model/client";
import { norm } from "@/lib/text/norm";
import type {
  RoleKey, Segment, SegmentKind, SensitivityCategory, SensitivityStage, SourceKind,
} from "@/lib/types";
import {
  FAMILY_WORDS, FINANCE_CUES, FINANCE_FEE_WORDS, FINANCE_PERSON_VERBS, FINANCE_TO_PERSON_VERBS, FINANCE_WEAK,
  FIRST_PERSON, FOLLOW_UP_CUES, FOLLOW_UP_MAX_MINUTES, FOLLOW_UP_MAX_SEGMENTS, HEALTH_AMBIGUOUS, HEALTH_TERMS,
  HEALTH_WEAK, HR_CUES, HR_JUDGEMENTS, HR_SOFT_CUES, HR_WEAK, IGNORE_PHRASES, JUDGEMENT_NAME_WINDOW,
  NAME_STOPWORDS, THIRD_PERSON, UPI_CONTEXT, UPI_HANDLES,
} from "./sensitivity-lexicon";

export type { SensitivityCategory, SensitivityStage } from "@/lib/types";

/** Bump when a lexicon or a rule changes: the pipeline then looks at stored segments again. */
export const CLASSIFIER_VERSION = 1;

export const CATEGORIES: readonly SensitivityCategory[] = ["finance", "hr", "health"];

/** The fixed reason strings shown on Connect. Nothing else is ever stored as a reason. */
export const REASONS = {
  health: "mentions a medical condition",
  finance: "mentions money a person owes or is owed",
  account: "mentions a bank or payment account",
  hr: "reads like a complaint about a person",
  follow: "follows a message that was limited",
  held: "could not be checked",
} as const;

export function reasonFor(category: SensitivityCategory): string {
  return REASONS[category];
}

export interface SensitivityDecision {
  segmentId: string;
  outcome: "clear" | "borderline" | "sensitive";
  /** Categories found (sensitive) or candidate categories (borderline). Empty when clear. */
  categories: SensitivityCategory[];
  stage: SensitivityStage | null;
  reason: string | null;
  /** Rule ids that fired, for tests and the results page. */
  hits: string[];
}

/** The part of the pack the classifier reads. */
export interface PackSensitivity {
  roles: Record<SensitivityCategory, RoleKey[]>;
  extraTerms?: Partial<Record<SensitivityCategory, { strong?: string[]; weak?: string[] }>>;
}

export interface RuleContext {
  /** Lowercase first and last names of known people. Only used to decide "is a person mentioned". */
  knownNames: string[];
  pack: PackSensitivity;
  /** Name parts per person id, so a complaint is about someone other than its author. */
  authorNames?: Record<string, string[]>;
}

/**
 * The pack's category-to-roles map. A pack that gives none keeps every category for its approver:
 * a setting that has not said who may see such content shows it to the approver only.
 */
export function packSensitivity(pack: {
  sensitivity?: Record<string, RoleKey[]>;
  sensitivityTerms?: Record<string, { strong?: string[]; weak?: string[] }>;
  approverRole: RoleKey;
}): PackSensitivity {
  const roles = {} as Record<SensitivityCategory, RoleKey[]>;
  for (const c of CATEGORIES) roles[c] = [...(pack.sensitivity?.[c] ?? [pack.approverRole])];
  const extraTerms: PackSensitivity["extraTerms"] = {};
  for (const c of CATEGORIES) if (pack.sensitivityTerms?.[c]) extraTerms[c] = pack.sensitivityTerms[c];
  return { roles, extraTerms };
}

/** Lowercase name parts of the given display names (first names, last names; no titles). */
export function nameParts(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    if (/\[(CONTACT|SECRET)/i.test(name)) continue;
    for (const part of name.normalize("NFKC").toLowerCase().split(/[^\p{L}]+/u)) {
      if (part.length < 3 || NAME_STOPWORDS.includes(part)) continue;
      out.add(part);
    }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------------------------
// Matching helpers (whole words; "x*" is a prefix)

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function termPattern(term: string): string {
  const prefix = term.endsWith("*");
  const body = esc(prefix ? term.slice(0, -1) : term).replace(/\s+/g, "\\s+");
  return prefix ? `${body}[a-z]*` : body;
}

const reCache = new Map<string, RegExp>();
function anyOf(terms: readonly string[]): RegExp | null {
  if (!terms.length) return null;
  const key = terms.join("\u0000");
  let re = reCache.get(key);
  if (!re) {
    const alt = [...terms].sort((a, b) => b.length - a.length).map(termPattern).join("|");
    re = new RegExp(`(?<![a-z0-9])(?:${alt})(?![a-z0-9])`, "g");
    reCache.set(key, re);
  }
  return re;
}

function matches(text: string, terms: readonly string[]): string[] {
  const re = anyOf(terms);
  if (!re) return [];
  return [...text.matchAll(re)].map((m) => m[0]);
}

const has = (text: string, terms: readonly string[]) => matches(text, terms).length > 0;

/** norm(), curly quotes straightened, contractions and possessive 's dropped. */
function prepare(raw: string): string {
  return norm(raw)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/'(?:s|m|re|ve|ll|d)(?![a-z])/g, "")
    .replace(/n't(?![a-z])/g, " not");
}

function stripIgnored(text: string): string {
  const re = anyOf(IGNORE_PHRASES);
  return re ? text.replace(re, " ") : text;
}

const AMOUNT_RE = new RegExp(
  "(?:(?:₹|\\brs\\.?|\\binr\\b|\\brupees?\\b)\\s*\\d[\\d,]*(?:\\.\\d+)?\\s*(?:k|lakhs?|lacs?|crores?)?(?![a-z0-9]))" +
  "|(?:\\b\\d[\\d,]*(?:\\.\\d+)?\\s*(?:k|lakhs?|lacs?|crores?)?\\s*(?:rs\\b|rupees?\\b|inr\\b|/-))",
  "i",
);
const IFSC_RE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/;
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/;
const UPI_RE = /(?<![\w.@-])[\w.-]{2,}@([a-z]{2,})(?![\w.])/gi;
const ACCOUNT_RE = /\b(?:account|a\/c|acct)\b(?:\W+\w+){0,3}?\W+\d{9,18}\b|\b\d{9,18}\b(?:\W+\w+){0,3}?\W+(?:account|a\/c|acct)\b/i;

function hasAccount(raw: string, text: string): boolean {
  if (IFSC_RE.test(raw) || PAN_RE.test(raw) || ACCOUNT_RE.test(raw)) return true;
  for (const m of raw.matchAll(UPI_RE)) {
    const handle = m[1].toLowerCase();
    if (UPI_HANDLES.includes(handle) || handle.startsWith("ok") || has(text, UPI_CONTEXT)) return true;
  }
  return false;
}

/** Known names present in the text. Capitalised in mixed-case text; any case in all-lowercase text. */
function namesIn(raw: string, names: readonly string[]): string[] {
  if (!names.length) return [];
  const mixedCase = /\p{Lu}/u.test(raw);
  const set = new Set(names);
  const out = new Set<string>();
  for (const m of raw.normalize("NFKC").matchAll(/\p{L}+/gu)) {
    const word = m[0];
    const lower = word.toLowerCase();
    if (!set.has(lower)) continue;
    if (mixedCase && !/^\p{Lu}/u.test(word)) continue;
    out.add(lower);
  }
  return [...out];
}

function words(text: string): string[] {
  return text.split(/[^a-z0-9]+/).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Rule stage

interface Finding { strong: Map<SensitivityCategory, string>; weak: Set<SensitivityCategory>; hits: string[] }

function withExtra(base: readonly string[], extra: string[] | undefined): readonly string[] {
  return extra?.length ? [...base, ...extra.map((t) => t.toLowerCase())] : base;
}

/** The text the rules read: the masked segment text, plus a task card's title and description. */
export function classifiedText(seg: Pick<Segment, "text" | "kind" | "meta">): string {
  if (seg.kind !== "task") return seg.text;
  const extra = [seg.meta?.title, seg.meta?.description].filter((x): x is string => typeof x === "string");
  return [seg.text, ...extra].join("\n");
}

function examine(raw: string, ctx: RuleContext, authorId: string | null): Finding {
  const f: Finding = { strong: new Map(), weak: new Set(), hits: [] };
  const text = stripIgnored(prepare(raw));
  const tokens = words(text);
  const extra = ctx.pack.extraTerms ?? {};
  const allNames = namesIn(raw, ctx.knownNames);
  const own = new Set(authorId ? (ctx.authorNames?.[authorId] ?? []) : []);
  const otherNames = allNames.filter((n) => !own.has(n));
  const firstPerson = tokens.some((t) => FIRST_PERSON.includes(t));
  const thirdPerson = tokens.some((t) => THIRD_PERSON.includes(t));
  const strong = (c: SensitivityCategory, rule: string, reason: string) => {
    if (!f.strong.has(c)) f.strong.set(c, reason);
    f.hits.push(rule);
  };
  const weak = (c: SensitivityCategory, rule: string) => {
    f.weak.add(c);
    f.hits.push(rule);
  };

  // Finance
  {
    const amount = AMOUNT_RE.test(text);
    const personWord = `(?:${[...FIRST_PERSON, ...THIRD_PERSON, "you", "they", ...allNames].map(esc).join("|")})`;
    const paidBy = new RegExp(`(?<![a-z0-9])${personWord}(?:\\s+(?:still|already|has|have|had|just|also))?\\s+(?:${FINANCE_PERSON_VERBS.join("|")})(?![a-z0-9])`);
    const paidTo = new RegExp(`(?<![a-z0-9])(?:${FINANCE_TO_PERSON_VERBS.map(termPattern).join("|")})\\s+(?:${[...THIRD_PERSON, "me", "you", "them", ...allNames].map(esc).join("|")})(?![a-z0-9])`);
    const cue = has(text, withExtra(FINANCE_CUES, extra.finance?.strong)) || paidBy.test(text) || paidTo.test(text);
    const person = allNames.length > 0 || firstPerson || thirdPerson;
    const weakTerms = new Set(matches(text, withExtra(FINANCE_WEAK, extra.finance?.weak)));
    if (hasAccount(raw, text)) strong("finance", "F1", REASONS.account);
    if (amount && cue && person) strong("finance", "F2", REASONS.finance);
    if (cue && allNames.length > 0 && has(text, FINANCE_FEE_WORDS)) strong("finance", "F3", REASONS.finance);
    if (!f.strong.has("finance") && (amount || cue || weakTerms.size >= 2)) weak("finance", "F4");
  }

  // HR
  {
    const hard = has(text, withExtra(HR_CUES, extra.hr?.strong));
    const soft = matches(text, HR_SOFT_CUES).length;
    const judgements = matches(text, HR_JUDGEMENTS);
    const complaint = hard || soft + judgements.length >= 2;
    if (complaint && otherNames.length > 0) strong("hr", "H1", REASONS.hr);
    let judged = false;
    if (judgements.length && otherNames.length) {
      const judgeWords = new Set(judgements.flatMap((j) => words(j)));
      const idx = tokens.map((t, i) => (judgeWords.has(t) ? i : -1)).filter((i) => i >= 0);
      const nameIdx = tokens.map((t, i) => (otherNames.includes(t) ? i : -1)).filter((i) => i >= 0);
      judged = idx.some((i) => nameIdx.some((j) => Math.abs(i - j) <= JUDGEMENT_NAME_WINDOW));
      if (judged) strong("hr", "H2", REASONS.hr);
    }
    if (!f.strong.has("hr")) {
      const weakTerm = has(text, withExtra(HR_WEAK, extra.hr?.weak));
      // A people matter needs a person: a name, or "he", "she", "you", "they" next to the cue.
      const someone = otherNames.length > 0 || thirdPerson || tokens.includes("you") || tokens.includes("they");
      if (((complaint || judgements.length > 0) && someone) || ((soft > 0 || weakTerm) && otherNames.length > 0)) weak("hr", "H3");
    }
  }

  // Health
  {
    const person = allNames.length > 0 || firstPerson || tokens.some((t) => FAMILY_WORDS.includes(t));
    const term = has(text, withExtra(HEALTH_TERMS, extra.health?.strong));
    const owner = `(?:${[...FIRST_PERSON, ...THIRD_PERSON, "your", "their", ...allNames, ...FAMILY_WORDS].map(esc).join("|")})`;
    const ambiguous = has(text, HEALTH_AMBIGUOUS);
    const owned = new RegExp(`(?<![a-z0-9])${owner}\\s+(?:\\w+\\s+)?(?:${HEALTH_AMBIGUOUS.join("|")})(?![a-z0-9])|(?<![a-z0-9])operated\\s+on(?![a-z0-9])`).test(text);
    const weakTerm = has(text, withExtra(HEALTH_WEAK, extra.health?.weak));
    if ((term || owned) && person) strong("health", "M1", REASONS.health);
    else if (term || owned || ((weakTerm || ambiguous) && person)) weak("health", "M2");
  }
  return f;
}

function decisionOf(seg: Pick<Segment, "id" | "kind">, f: Finding): SensitivityDecision {
  if (f.strong.size) {
    const categories = CATEGORIES.filter((c) => f.strong.has(c));
    return { segmentId: seg.id, outcome: "sensitive", categories, stage: "rule", reason: f.strong.get(categories[0])!, hits: f.hits };
  }
  // Repository files are full of words that look like weak terms: only strong rules count there.
  if (f.weak.size && seg.kind !== "file") {
    return { segmentId: seg.id, outcome: "borderline", categories: CATEGORIES.filter((c) => f.weak.has(c)), stage: null, reason: null, hits: f.hits };
  }
  return { segmentId: seg.id, outcome: "clear", categories: [], stage: null, reason: null, hits: [] };
}

const byTime = (a: Segment, b: Segment) =>
  Date.parse(a.ts) - Date.parse(b.ts) || a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Rule stage. Pure and synchronous. One decision per segment, in input order. */
export function classifyByRules(segs: readonly Segment[], ctx: RuleContext): SensitivityDecision[] {
  const decisions = new Map<string, SensitivityDecision>();
  for (const s of segs) decisions.set(s.id, decisionOf(s, examine(classifiedText(s), ctx, s.authorId)));

  const threads = new Map<string, Segment[]>();
  for (const s of segs) {
    const key = `${s.sourceId}\u0000${s.thread}`;
    const list = threads.get(key) ?? [];
    list.push(s);
    threads.set(key, list);
  }
  for (const list of threads.values()) {
    list.sort(byTime);
    const replyLinks = list.some((s) => typeof s.meta?.replyTo === "string");
    // R1: a reply to a limited message takes its categories. In time order, so chains follow.
    for (const s of list) {
      const parentId = typeof s.meta?.replyTo === "string" ? s.meta.replyTo : null;
      const parent = parentId ? decisions.get(parentId) : undefined;
      if (!parent || parent.outcome !== "sensitive") continue;
      const d = decisions.get(s.id)!;
      const categories = CATEGORIES.filter((c) => parent.categories.includes(c) || (d.outcome === "sensitive" && d.categories.includes(c)));
      decisions.set(s.id, {
        segmentId: s.id, outcome: "sensitive", categories,
        stage: d.outcome === "sensitive" ? d.stage : "follow",
        reason: d.outcome === "sensitive" ? d.reason : REASONS.follow,
        hits: [...d.hits, "R1"],
      });
    }
    if (replyLinks) continue;
    // R2: in a chat with no reply links, the next few messages are checked when they carry a
    // follow-up cue or name someone from the limited message. They become borderline, not limited.
    for (let i = 0; i < list.length; i++) {
      const parent = list[i];
      const pd = decisions.get(parent.id)!;
      if (parent.kind !== "message" || pd.outcome !== "sensitive" || pd.stage !== "rule") continue;
      const people = new Set([
        ...namesIn(classifiedText(parent), ctx.knownNames),
        ...(parent.authorId ? (ctx.authorNames?.[parent.authorId] ?? []) : []),
      ]);
      for (let j = i + 1; j < list.length && j <= i + FOLLOW_UP_MAX_SEGMENTS; j++) {
        const s = list[j];
        if (Date.parse(s.ts) - Date.parse(parent.ts) > FOLLOW_UP_MAX_MINUTES * 60_000) break;
        const d = decisions.get(s.id)!;
        if (d.outcome === "sensitive" || s.kind !== "message") continue;
        const raw = classifiedText(s);
        const cue = has(prepare(raw), FOLLOW_UP_CUES);
        const named = namesIn(raw, [...people]).length > 0;
        if (!cue && !named) continue;
        const categories = CATEGORIES.filter((c) => pd.categories.includes(c) || d.categories.includes(c));
        decisions.set(s.id, { segmentId: s.id, outcome: "borderline", categories, stage: null, reason: null, hits: [...d.hits, "R2"] });
      }
    }
  }
  return segs.map((s) => decisions.get(s.id)!);
}

// ---------------------------------------------------------------------------------------------
// Narrowing

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Narrow one role set to the roles the pack allows for every given category. Never returns a role
 * that is not in `current`. When no role would be left (the source already leaves out every
 * allowed role) the set is returned unchanged.
 */
export function narrowRoleSet(
  current: readonly RoleKey[], categories: readonly SensitivityCategory[], pack: PackSensitivity,
): RoleKey[] {
  let out = [...current];
  for (const c of categories) {
    const allowed = pack.roles[c] ?? [];
    out = out.filter((r) => allowed.includes(r));
  }
  return out.length ? out : [...current];
}

/** The sensitivity fields of a segment row, set from a decision. Roles are only ever removed. */
function stamp<S extends Segment>(seg: S, d: {
  categories: SensitivityCategory[]; stage: SensitivityStage | null; reason: string | null;
}, pack: PackSensitivity): S {
  if (!d.categories.length || !d.stage) {
    return { ...seg, sensitivity: [], sensitivityStage: null, sensitivityReason: null, roleSetOriginal: null, classifierVersion: CLASSIFIER_VERSION };
  }
  const roleSet = narrowRoleSet(seg.roleSet, d.categories, pack);
  const narrowed = !sameSet(roleSet, seg.roleSet);
  return {
    ...seg,
    roleSet,
    sensitivity: [...d.categories],
    sensitivityStage: d.stage,
    sensitivityReason: d.reason,
    roleSetOriginal: narrowed ? [...seg.roleSet] : null,
    classifierVersion: CLASSIFIER_VERSION,
  };
}

// ---------------------------------------------------------------------------------------------
// Model stage (borderline segments only)

export const SENSITIVITY_SCHEMA_NAME = "sensitivity_v1";
export const SENSITIVITY_MAX_CHARS = 4_000;
export const SENSITIVITY_BUDGET_MS = 20_000;
const MODEL_CONCURRENCY = 4;

export const sensitivityResponseSchema = z.strictObject({
  items: z.array(z.strictObject({
    segment_id: z.string(),
    category: z.enum(["finance", "hr", "health", "none"]),
  })),
});
export type SensitivityResponse = z.infer<typeof sensitivityResponseSchema>;

export const SENSITIVITY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["segment_id", "category"],
        properties: { segment_id: { type: "string" }, category: { type: "string", enum: ["finance", "hr", "health", "none"] } },
      },
    },
  },
} as const;

export interface SensitivityCallOpts {
  system: string;
  user: string;
  schema: typeof sensitivityResponseSchema;
  jsonSchemaName: string;
  jsonSchema: Record<string, unknown>;
  timeoutMs: number;
}
export type SensitivityModelCall = (opts: SensitivityCallOpts) => Promise<CallResult<SensitivityResponse>>;

export const SENSITIVITY_SYSTEM_PROMPT = [
  "You label messages from an organisation's internal channels for a privacy filter.",
  "For each message, decide whether it is private content of one of three kinds, or none.",
  "finance: money that an identifiable person owes, is owed, paid or was fined; a person's bank or payment account; a confidential amount such as a sponsorship sum, a salary or a quote under negotiation.",
  "hr: a complaint, an accusation or a negative judgement about an identifiable person's behaviour or work; a disciplinary matter.",
  "health: an identifiable person's illness, injury, treatment, mental health or medical leave, including good wishes that reveal it.",
  "Answer none when the text is routine business of the organisation: buying parts, public prices and fees, schedules, technical talk, idioms and jokes.",
  "A line in brackets under a message is context from the filter, not part of the message.",
  'Return JSON only: {"items":[{"segment_id":"<id>","category":"finance"|"hr"|"health"|"none"}]}, one item per message, ids copied exactly.',
].join("\n");

interface Borderline { seg: Segment; decision: SensitivityDecision; follows: SensitivityCategory[] }

/** Deterministic user prompt for one batch: ids, text, and the follow-up hint. Never the parent's text. */
export function sensitivityUserPrompt(batch: readonly Borderline[]): string {
  const lines: string[] = ["Messages:"];
  for (const b of batch) {
    lines.push(`[${b.seg.id}] ${classifiedText(b.seg).replace(/\s+/g, " ").trim()}`);
    if (b.follows.length) lines.push(`  (follows a message already limited as: ${b.follows.join(", ")})`);
  }
  return lines.join("\n");
}

export interface SensitivityReport {
  segments: number;
  /** Limited by a strong rule (including replies that inherit). */
  byRule: number;
  byFollow: number;
  /** Borderline segments the model was asked about, and what came of them. */
  borderline: number;
  byModel: number;
  clearedByModel: number;
  held: number;
  /** Segments whose role set actually got smaller. */
  narrowed: number;
  modelCalls: number;
  modelCached: number;
  ms: number;
  decisions: SensitivityDecision[];
}

export interface ClassifyOptions {
  /** The model call for borderline segments. Absent: every borderline segment is held. */
  call?: SensitivityModelCall;
  budgetMs?: number;
  knownNames: string[];
  authorNames?: Record<string, string[]>;
  /** Clock, for tests of the budget. */
  now?: () => number;
}

async function pool<T>(items: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/**
 * Rules, then the model for borderline segments. Returns copies with the role set narrowed and the
 * sensitivity fields set, in input order, plus the final decision per segment.
 */
export async function classifySegments(
  segments: readonly Segment[], pack: PackSensitivity, opts: ClassifyOptions,
): Promise<{ segments: Segment[]; report: SensitivityReport }> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const ctx: RuleContext = { knownNames: opts.knownNames, pack, authorNames: opts.authorNames };
  const ruled = classifyByRules(segments, ctx);
  const final = new Map<string, SensitivityDecision>(ruled.map((d) => [d.segmentId, d]));
  const byId = new Map(segments.map((s) => [s.id, s]));

  // Only borderline segments whose role set a category would actually cut go to the model.
  const borderline: Borderline[] = [];
  for (const d of ruled) {
    if (d.outcome !== "borderline") continue;
    const seg = byId.get(d.segmentId)!;
    if (sameSet(narrowRoleSet(seg.roleSet, d.categories, pack), seg.roleSet)) {
      final.set(d.segmentId, { ...d, outcome: "clear", categories: [], hits: d.hits });
      continue;
    }
    borderline.push({ seg, decision: d, follows: d.hits.includes("R2") ? d.categories : [] });
  }

  // Batches: one source and one role set per call, like extraction. Deterministic order.
  const groups = new Map<string, Borderline[]>();
  for (const b of borderline) {
    const key = `${b.seg.sourceId}\u0000${[...b.seg.roleSet].sort().join(",")}`;
    const list = groups.get(key) ?? [];
    list.push(b);
    groups.set(key, list);
  }
  const batches: Borderline[][] = [];
  for (const key of [...groups.keys()].sort()) {
    let cur: Borderline[] = [];
    let chars = 0;
    for (const b of groups.get(key)!.sort((x, y) => byTime(x.seg, y.seg))) {
      const n = classifiedText(b.seg).length + 40;
      if (cur.length && chars + n > SENSITIVITY_MAX_CHARS) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(b);
      chars += n;
    }
    if (cur.length) batches.push(cur);
  }

  let modelCalls = 0;
  let modelCached = 0;
  const hold = (b: Borderline) => final.set(b.seg.id, {
    segmentId: b.seg.id, outcome: "sensitive", categories: b.decision.categories, stage: "held", reason: REASONS.held, hits: b.decision.hits,
  });
  const deadline = t0 + (opts.budgetMs ?? SENSITIVITY_BUDGET_MS);
  await pool(batches, MODEL_CONCURRENCY, async (batch) => {
    const left = deadline - now();
    if (!opts.call || left <= 0) {
      batch.forEach(hold);
      return;
    }
    let res: CallResult<SensitivityResponse>;
    try {
      modelCalls++;
      const timer = new Promise<CallResult<SensitivityResponse>>((resolve) => {
        const t = setTimeout(() => resolve({ ok: false, error: "classifier budget used up" }), left);
        (t as { unref?: () => void }).unref?.();
      });
      res = await Promise.race([
        opts.call({
          system: SENSITIVITY_SYSTEM_PROMPT,
          user: sensitivityUserPrompt(batch),
          schema: sensitivityResponseSchema,
          jsonSchemaName: SENSITIVITY_SCHEMA_NAME,
          jsonSchema: SENSITIVITY_JSON_SCHEMA as unknown as Record<string, unknown>,
          timeoutMs: left,
        }),
        timer,
      ]);
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) {
      batch.forEach(hold);
      return;
    }
    if (res.cached) modelCached++;
    // The answer is re-validated here, so an injected call cannot smuggle in anything but the enum.
    const parsed = sensitivityResponseSchema.safeParse(res.data);
    if (!parsed.success) {
      batch.forEach(hold);
      return;
    }
    const answers = new Map<string, SensitivityCategory | "none">();
    for (const item of parsed.data.items) if (batch.some((b) => b.seg.id === item.segment_id)) answers.set(item.segment_id, item.category);
    for (const b of batch) {
      const a = answers.get(b.seg.id);
      if (a === undefined) hold(b);
      else if (a === "none") final.set(b.seg.id, { ...b.decision, outcome: "clear", categories: [] });
      else final.set(b.seg.id, { segmentId: b.seg.id, outcome: "sensitive", categories: [a], stage: "model", reason: reasonFor(a), hits: b.decision.hits });
    }
  });

  const out = segments.map((s) => {
    const d = final.get(s.id)!;
    return stamp(s, d.outcome === "sensitive" ? d : { categories: [], stage: null, reason: null }, pack);
  });
  const decisions = segments.map((s) => final.get(s.id)!);
  const count = (stage: SensitivityStage) => decisions.filter((d) => d.outcome === "sensitive" && d.stage === stage).length;
  return {
    segments: out,
    report: {
      segments: segments.length,
      byRule: count("rule"),
      byFollow: count("follow"),
      borderline: borderline.length,
      byModel: count("model"),
      clearedByModel: borderline.length - count("model") - count("held"),
      held: count("held"),
      narrowed: out.filter((s) => s.roleSetOriginal).length,
      modelCalls,
      modelCached,
      ms: now() - t0,
      decisions,
    },
  };
}

/** A parsed source as ingest holds it: only the segments are read and replaced. */
interface WithSegments { result: { segments: Segment[] } }

/**
 * Classify everything an ingest parsed, before the first write. Returns copies of the sources whose
 * segments carry the narrowed role set and the sensitivity fields.
 */
export async function applySensitivity<S extends WithSegments>(
  sources: readonly S[], pack: PackSensitivity, opts: ClassifyOptions,
): Promise<{ sources: S[]; report: SensitivityReport }> {
  const all = sources.flatMap((s) => s.result.segments);
  const { segments, report } = await classifySegments(all, pack, opts);
  const byId = new Map(segments.map((s) => [s.id, s]));
  return {
    sources: sources.map((s) => ({ ...s, result: { ...s.result, segments: s.result.segments.map((x) => byId.get(x.id) ?? x) } })),
    report,
  };
}

export interface NarrowResult {
  roleSet: RoleKey[];
  categories: SensitivityCategory[];
  stage: SensitivityStage | null;
  reason: string | null;
  /** Set when the role set got smaller: the role set before. */
  roleSetOriginal: RoleKey[] | null;
}

/**
 * For segments made outside ingest (a leaver's answer, a neighbour's answer, a finding). Rules
 * only: a strong hit limits the text, a borderline one is held for the approver. Call it before
 * the insert and store the returned role set and fields.
 */
export function narrowForSensitivity(
  text: string, kind: SegmentKind, roleSet: readonly RoleKey[], pack: PackSensitivity, knownNames: string[],
  sourceKind: SourceKind = "interview",
): NarrowResult {
  const seg: Segment = {
    id: "seg_new", sourceId: "src_new", sourceKind, kind, ts: new Date(0).toISOString(), authorId: null,
    thread: "", position: 0, text, textHash: "", roleSet: [...roleSet], version: 1, meta: {},
  };
  const [d] = classifyByRules([seg], { knownNames, pack });
  if (d.outcome === "clear") return { roleSet: [...roleSet], categories: [], stage: null, reason: null, roleSetOriginal: null };
  const stage: SensitivityStage = d.outcome === "sensitive" ? "rule" : "held";
  const reason = d.outcome === "sensitive" ? d.reason : REASONS.held;
  const next = narrowRoleSet(roleSet, d.categories, pack);
  return {
    roleSet: next, categories: d.categories, stage, reason,
    roleSetOriginal: sameSet(next, roleSet) ? null : [...roleSet],
  };
}
