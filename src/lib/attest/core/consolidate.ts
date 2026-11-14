// Attest consolidation: the second pass of two-pass extraction. Code only, no model.
// Spec: docs/round3/specs/04_round2_fixes.md section (a). Pure functions: inputs are never mutated.
//
// The candidate prompt is tuned for recall, so it repeats facts, files some under too broad an
// entity, and lists options next to decisions. This pass tidies the candidates before the
// verifier and the rules see them:
//   1. refile_entity     a candidate whose quote names another pack entity, and whose cited text
//                        does not name the entity the model chose, moves to the entity it names;
//   2. bind_event        a date, place or owner stays on its entity only when its `event` words or
//                        the text it was read from name that entity. A date or place for another
//                        event keeps its entity with the event written after the value,
//                        "2026-08-02 (stall)", and values with different events are never
//                        compared; a claim whose text never names its entity moves to the entity
//                        the text names, or to "other";
//   3. fold_options      considered, rejected and open options for one entity and attribute, and
//                        values that offer a choice ("A or B"), fold into one `decision` claim,
//                        "Options: A or B", with every citation kept;
//   4. merge_duplicates  the same fact said twice by one person inside one role set becomes one
//                        claim with the most specific value and the union of the citations;
//   5. location_kind     a place, a repo path, a URL and an account are different kinds of
//                        location and are never compared (read by ./rules through `locationKind`).
// Before these, example_echo drops a candidate whose value is a value from the prompt's own
// examples: the examples describe a made-up setting, so an echo of one is never a fact.
// Board and calendar rows (origin "structured") are never touched: their fields are not prose.
import type { Attribute, RoleKey, Segment } from "@/lib/types";
import { norm } from "@/lib/text/norm";
import { isWrittenDateDeadline } from "../dates";
import { OTHER_ENTITY, type DraftCitation, type DraftClaim, type PackEntity } from "./schema";

export type ConsolidationRule =
  | "example_echo" | "refile_entity" | "bind_event" | "fold_options" | "merge_duplicates" | "location_kind";

export const CONSOLIDATION_RULES: readonly ConsolidationRule[] = [
  "example_echo", "refile_entity", "bind_event", "fold_options", "merge_duplicates", "location_kind",
];

/** One consolidation decision, for the evaluation report and the tests. */
export interface ConsolidationFiring {
  rule: ConsolidationRule;
  entity: string;        // the entity the claim ends up on
  attribute: Attribute;
  value: string;         // the value the claim ends up with
  detail: string;
}

export interface ConsolidateOptions {
  /** The pack's entities (key, label, aliases, and `partOf` when the pack gives one). */
  entities: (PackEntity & { partOf?: string })[];
  segmentsById: Map<string, Segment>;
  /** The pack's role order (pack.roleOrder). */
  roleOrder: readonly RoleKey[];
  /** Values printed as examples in the prompt (see `exampleValues`). A candidate that repeats one is dropped. */
  exampleValues?: readonly string[];
}

/** The `value "..."` parts of a pack's prompt example lines. */
export function exampleValues(examples: Partial<Record<Attribute, string>> | undefined): string[] {
  const out: string[] = [];
  for (const line of Object.values(examples ?? {})) {
    const m = /value\s+"([^"]+)"/.exec(line ?? "");
    if (m) out.push(m[1]);
  }
  return out;
}

export interface ConsolidationResult {
  drafts: DraftClaim[];
  firings: ConsolidationFiring[];
  /** Firings per rule, every rule present. */
  counts: Record<ConsolidationRule, number>;
}

// ---------------------------------------------------------------------------------------------
// Text helpers

/** Lowercase, markup-free text with hyphens and underscores as spaces (same idea as entityToken). */
function flat(x: string): string {
  return norm(x).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOP = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "at", "and", "or", "with", "by", "from", "is", "are", "be",
  "our", "this", "that", "its", "it", "next", "new", "each", "date", "day", "time", "per", "as",
]);

/** Content words, lowercased, with a plural "s" removed, so "trials" and "trial" agree. */
export function contentTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of flat(text).matchAll(/[\p{L}\p{N}]+/gu)) {
    let t = m[0];
    if (STOP.has(t)) continue;
    if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

function namesOf(e: PackEntity): string[] {
  return [e.key, e.label, e.label.replace(/\([^)]*\)/g, " "), ...e.aliases].map(flat).filter(Boolean);
}

/**
 * Length of the longest name of `e` (key, label or alias) written as whole words in `text`; 0 when
 * none. `minWords` 2 counts only names of two or more words: one common word ("flash", "domain")
 * in a quote is weak evidence of what the quote is about.
 */
export function namedScore(text: string, e: PackEntity, minWords = 1): number {
  const h = flat(text);
  if (!h) return 0;
  let best = 0;
  for (const name of namesOf(e)) {
    if (name.length <= best) continue;
    if (minWords > 1 && name.split(" ").length < minWords) continue;
    if (new RegExp(`(?<![a-z0-9])${escapeRe(name)}(?:s|es)?(?![a-z0-9])`).test(h)) best = name.length;
  }
  return best;
}

/** The one entity named most specifically in `text` (longest name wins); null on no hit or a tie. */
function bestNamed(text: string, entities: PackEntity[], skip?: string, minWords = 1): { key: string; score: number } | null {
  let best: { key: string; score: number } | null = null;
  let tie = false;
  for (const e of entities) {
    if (e.key === skip) continue;
    const score = namedScore(text, e, minWords);
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { key: e.key, score };
      tie = false;
    } else if (score === best.score) {
      tie = true;
    }
  }
  return best && !tie ? best : null;
}

// ---------------------------------------------------------------------------------------------
// Values that carry meaning for the rules (read by ./rules `comparable`)

export type LocationKind = "url" | "path" | "service" | "place";

const FILE_EXT = /\.(md|txt|json|ya?ml|js|ts|tsx|sh|py|html?|css|csv|ics|pdf|ino|bin|toml|cfg|ini|env|xlsx?|docx?)\b/i;
const SERVICE_WORD =
  /\b(online|account|dashboard|portal|cloud|repo|repository|channel|website|web ?site|server|registrar|spreadsheet|wiki|inbox|e-?mail|releases?|(?:shared|cloud) (?:drive|folder))\b/i;

/** What a location value is: a web address, a file or folder path, an online service or account, or a physical place. */
export function locationKind(value: string): LocationKind {
  const v = baseValue(value).trim();
  // A bare descriptor after the value ("Acme Host (online)") says what kind it is.
  if (/^(online|web|website|url|account|repo|repository)$/i.test(eventOf(value))) return "service";
  if (/https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|org|net|io|dev|app|edu|gov|example|in|co)\b/i.test(v)) return "url";
  if (/[\\/]|^~|^\.{1,2}\w/.test(v) || FILE_EXT.test(v) || /^readme\b/i.test(v)) return "path";
  if (v.startsWith("#") || SERVICE_WORD.test(v)) return "service";
  return "place";
}

const LABEL = /^(.*\S)\s*\(([^()]+)\)\s*$/;

/** The event written after a value, "2026-08-02 (stall)" -> "stall"; "" when the value carries none. */
export function eventOf(value: string): string {
  const m = LABEL.exec(value.trim());
  return m ? m[2].trim() : "";
}

/** The value without its event label. */
export function baseValue(value: string): string {
  const m = LABEL.exec(value.trim());
  return m ? m[1] : value.trim();
}

/**
 * True when two values are about the same event: neither names one, or both do and the events
 * share a content word. A value that names an event and one that names none are different facts.
 */
export function sameEvent(a: string, b: string): boolean {
  const ea = contentTokens(eventOf(a));
  const eb = contentTokens(eventOf(b));
  if (ea.length === 0 && eb.length === 0) return true;
  if (ea.length === 0 || eb.length === 0) return false;
  return ea.some((t) => eb.includes(t));
}

const OPTIONS_PREFIX = /^(options?|rejected)\s*:/i;

/** True for the folded "Options: A or B" claim: it lists options, so it never conflicts or supersedes. */
export function isOptionsValue(value: string): boolean {
  return OPTIONS_PREFIX.test(value.trim());
}

// ---------------------------------------------------------------------------------------------

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}/;
const FOLDED: readonly Attribute[] = ["decision", "location", "owner", "deadline"];
const NEGATION = new Set(["not", "no", "never", "without", "except", "non", "un", "nobody", "none", "cannot"]);

function timeOf(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

interface Ctx {
  /** Per entity and attribute: the entity's name words plus the words of every event tied to them. */
  ownWords: Map<string, Set<string>>;
  entities: (PackEntity & { partOf?: string })[];
  byKey: Map<string, PackEntity & { partOf?: string }>;
  segs: Map<string, Segment>;
  roleOrder: readonly RoleKey[];
}

function citedSegments(d: DraftClaim, ctx: Ctx): Segment[] {
  const out: Segment[] = [];
  const seen = new Set<string>();
  for (const c of d.citations) {
    const s = ctx.segs.get(c.segmentId);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

/** The role set the claim will get (intersection of its cited segments), as a key. "" when nothing is cited. */
function roleKey(d: DraftClaim, ctx: Ctx): string {
  const segs = citedSegments(d, ctx);
  if (!segs.length) return "";
  return ctx.roleOrder.filter((r) => segs.every((s) => s.roleSet.includes(r))).join(",");
}

function newest(segs: Segment[]): Segment | null {
  let best: Segment | null = null;
  for (const s of segs) if (!best || timeOf(s.ts) > timeOf(best.ts) || (timeOf(s.ts) === timeOf(best.ts) && s.id > best.id)) best = s;
  return best;
}

function quotesOf(d: DraftClaim): string {
  return d.citations.map((c) => c.quote ?? "").filter(Boolean).join(" \n ");
}

function unionCitations(lists: DraftCitation[][]): DraftCitation[] {
  const seen = new Set<string>();
  const out: DraftCitation[] = [];
  for (const list of lists) {
    for (const c of list) {
      const k = `${c.segmentId}\u0000${c.quote ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...c });
    }
  }
  return out;
}

const isCandidate = (d: DraftClaim) => d.origin === "extracted";
const stanceOf = (d: DraftClaim) => d.stance ?? "decided";

// ---------------------------------------------------------------------------------------------
// Rule 1: re-file to the most specific entity

/**
 * Move a candidate to the entity its quote names when either
 * - that entity is a part of the chosen one (pack `partOf`), or
 * - the quote names it by a name of two or more words, and neither the quote nor the cited
 *   segments (text and thread name) name the chosen entity.
 * A quote that names two other entities equally well moves nothing.
 */
function refile(d: DraftClaim, ctx: Ctx, firings: ConsolidationFiring[]): DraftClaim {
  if (!isCandidate(d) || d.entity === OTHER_ENTITY) return d;
  const quote = quotesOf(d);
  if (!quote) return d;
  const chosen = ctx.byKey.get(d.entity);
  if (!chosen) return d;
  const part = bestNamed(quote, ctx.entities.filter((e) => e.partOf === d.entity));
  const hit = part ?? bestNamed(quote, ctx.entities, d.entity, 2);
  if (!hit) return d;
  const target = ctx.byKey.get(hit.key)!;
  const isPart = target.partOf === d.entity;
  if (!isPart) {
    if (namedScore(quote, chosen) > 0) return d;
    const around = citedSegments(d, ctx).map((s) => `${s.thread}\n${s.text}`).join("\n");
    if (namedScore(around, chosen) > 0) return d;
  } else if (namedScore(quote, chosen) >= hit.score) {
    return d;
  }
  firings.push({
    rule: "refile_entity",
    entity: target.key,
    attribute: d.attribute,
    value: d.value,
    detail: isPart
      ? `moved from ${d.entity}: the quote names its part ${target.key}`
      : `moved from ${d.entity}: the quote names ${target.key} and the cited text does not name ${d.entity}`,
  });
  return { ...d, entity: target.key, entityRaw: null };
}

// ---------------------------------------------------------------------------------------------
// Rule 2: bind dates, places and owners to the entity and event they are for

const BOUND: readonly Attribute[] = ["deadline", "location", "owner"];

/** What the claim was read from: its quotes, the cited segments, their thread names and the messages they reply to. */
function contextOf(d: DraftClaim, ctx: Ctx): string {
  const parts: string[] = [quotesOf(d)];
  for (const s of citedSegments(d, ctx)) {
    parts.push(s.thread, s.text);
    const to = s.meta?.replyTo;
    const parent = typeof to === "string" ? ctx.segs.get(to) : undefined;
    if (parent) parts.push(parent.text);
  }
  return parts.join("\n");
}

/**
 * A decided date, place or owner stays on the entity the model chose only when something ties it
 * there: the `event` words name the entity (they share a content word with its key, label or
 * aliases), or the text it was read from names the entity. Otherwise:
 * - `event` words that name another entity move the claim there;
 * - a date or place for an event of its own keeps its entity and carries the event in its value,
 *   "2026-08-02 (stall)", so it is never compared with the entity's own date or place;
 * - a claim whose text never names the chosen entity moves to the entity the text does name, or
 *   to "other" (a list of who holds which post is not the owner of whatever the model filed it under).
 */
function bindEvent(d: DraftClaim, ctx: Ctx, firings: ConsolidationFiring[]): DraftClaim {
  if (!isCandidate(d) || stanceOf(d) !== "decided" || !BOUND.includes(d.attribute)) return d;
  if (d.entity === OTHER_ENTITY) return d;
  const chosen = ctx.byKey.get(d.entity);
  if (!chosen) return d;
  if (d.attribute !== "owner" && eventOf(d.value)) return d;
  if (d.attribute === "deadline") {
    if (!DATE_VALUE.test(d.value.trim())) return d; // a cadence is never compared with a date
    // A date that is only the day its source was written is dropped by the verifier: leave it bare.
    const cited = citedSegments(d, ctx).map((s) => ({
      ts: s.ts,
      text: s.text,
      quote: d.citations.find((c) => c.segmentId === s.id)?.quote ?? null,
    }));
    if (isWrittenDateDeadline(d.value, cited)) return d;
  }
  const what = d.attribute === "deadline" ? "date" : d.attribute === "location" ? "place" : "owner";
  const event = d.attribute === "owner" ? "" : (d.event ?? "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  const words = contentTokens(event);
  const own = ctx.ownWords.get(`${d.entity}\u0000${d.attribute}`) ?? new Set(namesOf(chosen).flatMap(contentTokens));
  if (words.some((w) => own.has(w))) return d;

  const quote = quotesOf(d);
  const grounded = namedScore(contextOf(d, ctx), chosen) > 0;
  // The value itself often repeats the event ("Hall 2" for the event "Hall 2"): not a separate event.
  const valueWords = new Set(contentTokens(d.value));
  const ownEvent = words.length > 0 && !words.every((w) => valueWords.has(w));
  if (ownEvent) {
    const other = bestNamed(event, ctx.entities, d.entity);
    if (other && namedScore(quote, chosen) === 0) {
      firings.push({
        rule: "bind_event",
        entity: other.key,
        attribute: d.attribute,
        value: d.value,
        detail: `moved from ${d.entity}: the ${what} is for "${event}"`,
      });
      return { ...d, entity: other.key, entityRaw: null };
    }
    if (grounded) {
      const value = `${d.value.trim()} (${event})`;
      firings.push({
        rule: "bind_event",
        entity: d.entity,
        attribute: d.attribute,
        value,
        detail: `kept on ${d.entity} as its own event "${event}", not compared with other ${what}s`,
      });
      return { ...d, value };
    }
  }
  if (grounded) return d;
  const named = bestNamed(quote, ctx.entities, d.entity, 2) ?? bestNamed(contextOf(d, ctx), ctx.entities, d.entity, 2);
  const target = named?.key ?? OTHER_ENTITY;
  firings.push({
    rule: "bind_event",
    entity: target,
    attribute: d.attribute,
    value: d.value,
    detail: `moved from ${d.entity}: the text this ${what} was read from never names ${d.entity}`,
  });
  return { ...d, entity: target, entityRaw: null };
}

/**
 * The words that mean "this entity's own event", per entity and attribute: the words of its key,
 * label and aliases, plus the words of every candidate event that shares a word with them, to a
 * fixed point. "check-in with Sam" names the entity through "Sam"; a later "check-in" is then the
 * same event, not a new one.
 */
function ownEventWords(drafts: DraftClaim[], ctx: Ctx): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const events = new Map<string, string[][]>();
  for (const d of drafts) {
    if (!isCandidate(d) || !d.event || (d.attribute !== "deadline" && d.attribute !== "location")) continue;
    const chosen = ctx.byKey.get(d.entity);
    if (!chosen) continue;
    const key = `${d.entity}\u0000${d.attribute}`;
    if (!out.has(key)) out.set(key, new Set(namesOf(chosen).flatMap(contentTokens)));
    const words = contentTokens(d.event);
    if (words.length) events.set(key, [...(events.get(key) ?? []), words]);
  }
  for (const [key, own] of out) {
    const list = events.get(key) ?? [];
    for (let changed = true; changed; ) {
      changed = false;
      for (const words of list) {
        if (!words.some((w) => own.has(w)) || words.every((w) => own.has(w))) continue;
        for (const w of words) own.add(w);
        changed = true;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rule 3: fold considered and rejected options into one claim

const ATTR_WORD: Partial<Record<Attribute, string>> = {
  decision: "", location: " for where", owner: " for who owns it", deadline: " for when",
};

/**
 * A single-valued fact whose value offers a choice ("Hall 2 or the yard") is not settled, whatever
 * stance the model gave it. Decisions are left alone: "A or B, whichever is free" can be the decision.
 */
function listsAlternatives(d: DraftClaim): boolean {
  if (d.attribute === "decision") return false;
  if (d.attribute === "deadline" && !DATE_VALUE.test(d.value.trim())) return false;
  return /\S\s+or\s+\S/i.test(baseValue(d.value));
}

const HEDGE =
  /\b(not (?:yet )?(?:final|decided|confirmed|settled|fixed)|undecided|tentative(?:ly)?|preferred|prefer|proposed?|proposal|to be (?:confirmed|decided)|tbc|tbd|might|maybe|shortlist(?:ed)?)\b/i;

/** The cited quote itself says the matter is open ("not final", "preferred", "to be confirmed"). */
function hedged(d: DraftClaim): boolean {
  return d.attribute !== "decision" && HEDGE.test(quotesOf(d));
}

function distinctValues(ds: DraftClaim[]): string[] {
  const out: string[] = [];
  for (const d of ds) {
    const v = d.value.trim();
    const n = flat(v);
    if (!n || out.some((x) => flat(x) === n)) continue;
    out.push(v);
  }
  return out;
}

/**
 * Only a `decided` candidate yields a decision, location, owner or deadline. Every considered,
 * rejected or open candidate for one entity, role set and attribute folds into one `decision`
 * claim whose value lists the options. It keeps every citation, so each option stays checkable.
 */
function foldOptions(drafts: DraftClaim[], ctx: Ctx, firings: ConsolidationFiring[]): DraftClaim[] {
  const groups = new Map<string, DraftClaim[]>();
  const keep: (DraftClaim | { fold: string })[] = [];
  const open = (d: DraftClaim) =>
    isCandidate(d) && FOLDED.includes(d.attribute) && d.entity !== OTHER_ENTITY &&
    (stanceOf(d) !== "decided" || listsAlternatives(d) || hedged(d));
  // Values already under consideration, per entity and attribute: the same value stated flatly
  // elsewhere ("Hall 2 has the better power") is still an option, not the settled answer.
  const optionValues = new Map<string, string[]>();
  for (const d of drafts) {
    if (!open(d) || d.attribute === "decision") continue;
    const key = `${d.entity}\u0000${d.attribute}`;
    optionValues.set(key, [...(optionValues.get(key) ?? []), flat(baseValue(d.value))]);
  }
  const listed = (d: DraftClaim) => {
    if (!isCandidate(d) || d.attribute === "decision" || !FOLDED.includes(d.attribute)) return false;
    const v = flat(baseValue(d.value));
    if (v.length < 3) return false;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, "u");
    return (optionValues.get(`${d.entity}\u0000${d.attribute}`) ?? []).some((o) => re.test(o));
  };
  for (const d of drafts) {
    const foldable = open(d) || (d.entity !== OTHER_ENTITY && listed(d));
    if (!foldable) {
      keep.push(d);
      continue;
    }
    const key = `${d.entity}\u0000${roleKey(d, ctx)}\u0000${d.attribute}`;
    const g = groups.get(key);
    if (g) g.push(d);
    else {
      groups.set(key, [d]);
      keep.push({ fold: key });
    }
  }
  return keep.map((item) => {
    if (!("fold" in item)) return item;
    const group = groups.get(item.fold)!;
    const first = group[0];
    const considered = distinctValues(group.filter((d) => stanceOf(d) !== "rejected"));
    const rejected = distinctValues(group.filter((d) => stanceOf(d) === "rejected")).filter(
      (v) => !considered.some((c) => flat(c) === flat(v)),
    );
    const value = considered.length
      ? `Options: ${considered.join(" or ")}${rejected.length ? `; rejected: ${rejected.join(", ")}` : ""}`
      : `Rejected: ${rejected.join(", ")}`;
    const label = ctx.byKey.get(first.entity)?.label ?? first.entity;
    const statement =
      `Options${ATTR_WORD[first.attribute] ?? ""} (${label}), not settled in this text: ` +
      (considered.length ? `considered ${considered.join(" or ")}` : "") +
      (considered.length && rejected.length ? "; " : "") +
      (rejected.length ? `rejected ${rejected.join(", ")}` : "") +
      ".";
    firings.push({
      rule: "fold_options",
      entity: first.entity,
      attribute: "decision",
      value,
      detail: `${group.length} ${first.attribute} candidate(s) with stance ${[...new Set(group.map(stanceOf))].join(", ")} folded into one claim`,
    });
    const folded: DraftClaim = {
      entity: first.entity,
      entityRaw: null,
      attribute: "decision",
      value,
      statement,
      citations: unionCitations(group.map((d) => d.citations)),
      origin: "extracted",
      batchId: first.batchId,
      batchSegmentIds: [...new Set(group.flatMap((d) => d.batchSegmentIds))],
      stance: "considered",
      event: "",
    };
    return folded;
  });
}

// ---------------------------------------------------------------------------------------------
// Rule 4: merge duplicates inside one role set

/** Equal after normalising, or (not for dates and option lists) one holds the other as whole words with no negation added. */
export function sameFact(a: DraftClaim, b: DraftClaim): boolean {
  const va = flat(a.value);
  const vb = flat(b.value);
  if (!va || !vb) return false;
  if (va === vb) return true;
  if (a.attribute === "deadline" || isOptionsValue(a.value) || isOptionsValue(b.value)) return false;
  if (eventOf(a.value) !== eventOf(b.value)) return false;
  const [short, long] = va.length <= vb.length ? [va, vb] : [vb, va];
  if (short.length < 3) return false;
  if (!new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(short)}(?![\\p{L}\\p{N}])`, "u").test(long)) return false;
  const extra = long.replace(short, " ").split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  return !extra.some((t) => NEGATION.has(t) || t.endsWith("n't"));
}

/**
 * The same fact twice becomes one claim: same entity, attribute and role set, said by the same
 * person in the same kind of source (so two people who agree stay two claims and can corroborate
 * each other). The most specific (longest) value wins and every citation is kept.
 */
function mergeDuplicates(drafts: DraftClaim[], ctx: Ctx, firings: ConsolidationFiring[]): DraftClaim[] {
  const groups = new Map<string, number[]>();
  drafts.forEach((d, i) => {
    if (!isCandidate(d)) return;
    const segs = citedSegments(d, ctx);
    if (!segs.length) return;
    const kinds = [...new Set(segs.map((s) => s.sourceKind))].sort().join(",");
    const author = newest(segs)?.authorId ?? "";
    const key = [d.entity, d.attribute, roleKey(d, ctx), kinds, author].join("\u0000");
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });

  const replaced = new Map<number, DraftClaim | null>();
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const clusters: number[][] = [];
    for (const i of idxs) {
      const c = clusters.find((cl) => cl.some((j) => sameFact(drafts[i], drafts[j])));
      if (c) c.push(i);
      else clusters.push([i]);
    }
    for (const cl of clusters) {
      if (cl.length < 2) continue;
      const members = cl.map((i) => drafts[i]);
      const best = members.reduce((a, b) =>
        b.value.trim().length > a.value.trim().length ||
        (b.value.trim().length === a.value.trim().length && b.statement.length > a.statement.length) ? b : a,
      );
      const merged: DraftClaim = {
        ...best,
        citations: unionCitations([best.citations, ...members.filter((m) => m !== best).map((m) => m.citations)]),
        batchSegmentIds: [...new Set(members.flatMap((m) => m.batchSegmentIds))],
      };
      replaced.set(cl[0], merged);
      for (const i of cl.slice(1)) replaced.set(i, null);
      firings.push({
        rule: "merge_duplicates",
        entity: merged.entity,
        attribute: merged.attribute,
        value: merged.value,
        detail: `${cl.length} candidates merged, ${merged.citations.length} citation(s) kept`,
      });
    }
  }
  const out: DraftClaim[] = [];
  drafts.forEach((d, i) => {
    if (!replaced.has(i)) out.push(d);
    else {
      const r = replaced.get(i);
      if (r) out.push(r);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rule 5: location kind (the classification is read by ./rules; here it is only counted)

function locationKinds(drafts: DraftClaim[], firings: ConsolidationFiring[]): void {
  const byEntity = new Map<string, Map<LocationKind, string>>();
  for (const d of drafts) {
    if (d.attribute !== "location" || d.entity === OTHER_ENTITY || isOptionsValue(d.value)) continue;
    let kinds = byEntity.get(d.entity);
    if (!kinds) byEntity.set(d.entity, (kinds = new Map()));
    const k = locationKind(d.value);
    if (!kinds.has(k)) kinds.set(k, d.value);
  }
  for (const [entity, kinds] of byEntity) {
    if (kinds.size < 2) continue;
    firings.push({
      rule: "location_kind",
      entity,
      attribute: "location",
      value: [...kinds.values()].join(" | "),
      detail: `${kinds.size} kinds of location (${[...kinds.keys()].join(", ")}): kept apart, never compared`,
    });
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Run the consolidation rules over a draft list, in order: drop example echoes, re-file, bind
 * events, fold options, merge duplicates, then count location kinds. Deterministic: the same drafts and segments give
 * the same result. Structured drafts pass through unchanged.
 */
export function consolidate(drafts: DraftClaim[], opts: ConsolidateOptions): ConsolidationResult {
  const ctx: Ctx = {
    entities: opts.entities,
    byKey: new Map(opts.entities.map((e) => [e.key, e])),
    segs: opts.segmentsById,
    roleOrder: opts.roleOrder,
    ownWords: new Map(),
  };
  const firings: ConsolidationFiring[] = [];
  const echoes = new Set((opts.exampleValues ?? []).map(flat).filter(Boolean));
  let out = drafts.filter((d) => {
    if (!isCandidate(d) || !echoes.has(flat(d.value))) return true;
    firings.push({
      rule: "example_echo",
      entity: d.entity,
      attribute: d.attribute,
      value: d.value,
      detail: "dropped: the value repeats an example from the prompt, not the text",
    });
    return false;
  });
  out = out.map((d) => refile(d, ctx, firings));
  ctx.ownWords = ownEventWords(out, ctx);
  out = out.map((d) => bindEvent(d, ctx, firings));
  out = foldOptions(out, ctx, firings);
  out = mergeDuplicates(out, ctx, firings);
  locationKinds(out, firings);
  const counts = Object.fromEntries(CONSOLIDATION_RULES.map((r) => [r, 0])) as Record<ConsolidationRule, number>;
  for (const f of firings) counts[f.rule]++;
  return { drafts: out, firings, counts };
}
