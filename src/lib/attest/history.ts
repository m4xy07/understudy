// Claim history: one claim's claim_events in time order, as one role may see them.
// Contract: docs/ARCHITECTURE.md section 4 "Claims (Attest)" (every change is a claim_events row)
// and section 5 (RLS is the boundary).
//
// Everything is read inside withRole(), in one transaction:
//   1. the claim itself (claims policy). Not visible, or no such claim: null, and nothing else is read.
//   2. its events (claim_events policy, 0014: an event exists only when its claim does).
//   3. the other claims and segments the events point to, so a link is shown only when the role
//      could open it anyway. A hidden one is left out without a word.
// Event data is free-form jsonb written by several modules. Nothing from it is passed through as
// is: describeEvent() picks known fields and turns them into fixed sentences, so a field added
// later (a role set, a sensitivity category) never reaches the page by accident.
import { withRole, isRoleKey } from "@/lib/db/withRole";
import { toClaim } from "@/lib/db/mappers";
import { isRoleOf, roleLabel, type ResolvedPack } from "@/lib/pack";
import { TRUST_LABEL } from "@/lib/trust";
import type { Claim, ClaimOrigin, RoleKey, Trust } from "@/lib/types";

export type HistoryKind =
  | "created" | "verified" | "superseded" | "conflicting" | "dropped" | "reactivated"
  | "support_checked" | "updated" | "approved" | "rejected" | "edited" | "narrowed" | "other";

/** One row of the timeline. Every string is built by code from known fields. */
export interface HistoryEntry {
  id: string;
  at: string;                    // ISO time the event was written
  kind: HistoryKind;
  title: string;                 // "Superseded", "Approved", ...
  actor: string | null;          // the role key that acted; null when the system did
  lines: string[];               // plain sentences: what changed
  rule: string | null;           // superseded and conflicting: the rule that fired, in words
  segmentId: string | null;      // a source the event cites (answers, findings), only when visible
  related: { id: string; statement: string; relation: string } | null;  // only when visible
}

export interface ClaimHistory {
  claim: Claim;
  entries: HistoryEntry[];
  /** Entries after creation. 0 means "No changes since this claim was created". */
  changes: number;
}

/** The shape of a claim_events row as read from the database. */
export interface RawEvent {
  id: string;
  event: string;
  data: unknown;
  actor: string;
  createdAt: string;
}

const CLAIM_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isClaimIdParam(x: unknown): x is string {
  return typeof x === "string" && CLAIM_ID_RE.test(x);
}

const KIND_OF_EVENT: Record<string, HistoryKind> = {
  created: "created",
  verified: "verified",
  superseded: "superseded",
  conflicting: "conflicting",
  dropped: "dropped",
  reactivated: "reactivated",
  support_checked: "support_checked",
  updated: "updated",
  claim_approved: "approved",
  claim_rejected: "rejected",
  claim_edited: "edited",
  narrowed: "narrowed",
};

const TITLE: Record<HistoryKind, string> = {
  created: "Created",
  verified: "Label changed",
  superseded: "Superseded",
  conflicting: "Marked conflicting",
  dropped: "Dropped",
  reactivated: "Active again",
  support_checked: "Support checked",
  updated: "Updated",
  approved: "Approved",
  rejected: "Rejected",
  edited: "Edited",
  narrowed: "Fewer roles can see it",
  other: "Changed",
};

const ORIGIN_LABEL: Record<ClaimOrigin, string> = {
  extracted: "Drafted by the model from the record.",
  structured: "Read by rule from a structured source.",
  leaver_answer: "An answer from the leaver.",
  neighbour_answer: "An answer from a colleague.",
  trace: "Worked out from files and history.",
  successor_finding: "A finding from the successor.",
};

/** Used when an event names a rule number but carries no note. */
const RULE_TEXT: Record<number, string> = {
  1: "a source with more authority for this kind of fact replaced it",
  2: "the same person, or a reply, updated it",
  3: "two people disagree and no rule settles it",
  4: "a newer source with less authority disagrees",
};

const FIELD_LABEL: Record<string, string> = {
  trust: "Label",
  state: "State",
  importance: "Importance",
  tier: "Review tier",
  supportCheck: "Support check",
  citations: "Citations",
};

// --- small readers for untrusted jsonb ---------------------------------------------------------

/**
 * Event data as an object. The driver can hand jsonb back as text, and a row written with
 * `${JSON.stringify(x)}::jsonb` can hold a JSON string of the object, so parse up to twice.
 */
export function eventData(x: unknown): Record<string, unknown> {
  let v = x;
  for (let i = 0; i < 2 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return obj(v);
}

function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function str(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

function plain(x: unknown): string | null {
  if (typeof x === "number" && Number.isFinite(x)) return String(x);
  const s = str(x);
  if (!s) return null;
  return s in TRUST_LABEL ? TRUST_LABEL[s as Trust] : s;
}

function quoted(label: string, x: unknown): string | null {
  const s = str(x);
  return s ? `${label}: "${s}"` : null;
}

// --- pure mapping ------------------------------------------------------------------------------

/** "Superseded: the task board owns deadlines (...)" → "the task board owns deadlines (...)". */
export function ruleText(note: unknown, rule: unknown): string | null {
  const s = str(note);
  if (s) return s.replace(/^(Superseded|Conflicting):\s*/, "");
  return typeof rule === "number" ? RULE_TEXT[rule] ?? null : null;
}

function changeLines(changes: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [field, label] of Object.entries(FIELD_LABEL)) {
    if (!(field in changes)) continue;
    const c = obj(changes[field]);
    const from = plain(c.from);
    const to = plain(c.to);
    if (from && to) out.push(`${label}: ${from} → ${to}`);
    else if (to) out.push(`${label}: ${to}`);
  }
  return out;
}

function createdLines(d: Record<string, unknown>): string[] {
  const origin = str(d.origin);
  const out: string[] = [];
  if (origin && origin in ORIGIN_LABEL) out.push(ORIGIN_LABEL[origin as ClaimOrigin]);
  const trust = plain(d.trust);
  if (trust) out.push(`Label: ${trust}`);
  const value = quoted("Value", d.value);
  if (value) out.push(value);
  if (typeof d.steps === "number") {
    const q = typeof d.quoted === "number" ? d.quoted : 0;
    out.push(`${d.steps} step${d.steps === 1 ? "" : "s"}, ${q} quoted from a source.`);
  }
  if (d.narrowed === true) out.push("Saved for fewer roles than usual.");
  return out;
}

function reviewLines(kind: HistoryKind, d: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (d.bulk === true) out.push("Approved together with the other tier A claims.");
  else if (str(d.tier)) out.push(`Review tier ${str(d.tier)}.`);
  if (d.evidenceOpened === true) out.push("The evidence was opened first.");
  if (kind === "edited") {
    const before = obj(d.before);
    const after = obj(d.after);
    if (str(before.statement) !== str(after.statement)) {
      const b = quoted("Before", before.statement);
      const a = quoted("After", after.statement);
      if (b) out.push(b);
      if (a) out.push(a);
    }
    if (str(before.value) !== str(after.value) && str(after.value)) out.push(`Value: ${str(before.value) ?? "none"} → ${str(after.value)}`);
  }
  const note = quoted("Reviewer's note", d.note);
  if (note) out.push(note);
  return out;
}

/** The claim id an event points to, other than its own claim (winner or other side). */
export function relatedIdOf(claimId: string, data: unknown): string | null {
  const d = eventData(data);
  const sup = str(obj(obj(d.changes).supersededBy).to);
  if (sup && sup !== claimId) return sup;
  const older = str(d.olderId);
  const newer = str(d.newerId);
  if (older === claimId && newer) return newer;
  if (newer === claimId && older) return older;
  return null;
}

/** The segment an event cites directly (an answer or a finding), if any. */
export function segmentIdOf(data: unknown): string | null {
  return str(eventData(data).segmentId);
}

/**
 * One event as a timeline row. `visibleClaims` and `visibleSegments` hold only what the role
 * can read; anything else an event points to is left out.
 */
export function describeEvent(
  claimId: string,
  e: RawEvent,
  visibleClaims: ReadonlyMap<string, string>,
  visibleSegments: ReadonlySet<string>,
): HistoryEntry {
  const kind = KIND_OF_EVENT[e.event] ?? "other";
  const d = eventData(e.data);
  let lines: string[];
  if (kind === "created") lines = createdLines(d);
  else if (kind === "approved" || kind === "rejected" || kind === "edited") lines = reviewLines(kind, d);
  else lines = changeLines(obj(d.changes));
  if (str(d.trigger)) lines.push("After the rules ran again.");
  if (kind === "dropped" || kind === "reactivated") {
    const note = str(d.note);
    if (note) lines.push(note);
  }
  const rule = kind === "superseded" || kind === "conflicting" ? ruleText(d.note, d.rule) : null;
  const relId = relatedIdOf(claimId, d);
  const relStatement = relId ? visibleClaims.get(relId) : undefined;
  const related = relId && relStatement !== undefined
    ? { id: relId, statement: relStatement, relation: kind === "superseded" ? "Replaced by" : "Compared with" }
    : null;
  const seg = segmentIdOf(d);
  return {
    id: e.id,
    at: e.createdAt,
    kind,
    title: TITLE[kind],
    actor: e.actor && e.actor !== "system" ? e.actor : null,
    lines,
    rule,
    segmentId: seg && visibleSegments.has(seg) ? seg : null,
    related,
  };
}

/** Who acted, in words from the workspace's pack. */
export function actorLabel(actor: string | null, pack: Pick<ResolvedPack, "roles">): string {
  if (!actor) return "System";
  return isRoleOf(pack, actor) ? roleLabel(actor, pack) : "Unknown role";
}

function iso(x: unknown): string {
  const d = x instanceof Date ? x : new Date(String(x));
  return Number.isNaN(d.getTime()) ? String(x) : d.toISOString();
}

// --- the role-scoped read ----------------------------------------------------------------------

/**
 * One claim's history as `role` sees it, oldest first. Returns null when the claim does not exist
 * in this workspace or the role cannot see it: the caller cannot tell the two apart.
 */
export async function getClaimHistory(ws: string, claimId: string, role: RoleKey): Promise<ClaimHistory | null> {
  if (!isClaimIdParam(claimId) || !isRoleKey(role)) return null;
  return withRole(ws, role, async (tx) => {
    const [row] = await tx`SELECT * FROM claims WHERE workspace_id = ${ws} AND id = ${claimId}`;
    if (!row) return null;
    const claim = toClaim(row);
    const rows = await tx`
      SELECT id, event, data, actor, created_at FROM claim_events
      WHERE workspace_id = ${ws} AND claim_id = ${claimId}
      ORDER BY created_at, id`;
    const events: RawEvent[] = rows.map((r) => ({
      id: String(r.id), event: String(r.event), data: eventData(r.data), actor: String(r.actor), createdAt: iso(r.created_at),
    }));

    const relIds = [...new Set(events.map((e) => relatedIdOf(claimId, e.data)).filter((x): x is string => !!x))];
    const segIds = [...new Set(events.map((e) => segmentIdOf(e.data)).filter((x): x is string => !!x))];
    const visibleClaims = new Map<string, string>();
    if (relIds.length) {
      const rel = await tx`SELECT id, statement FROM claims WHERE workspace_id = ${ws} AND id = ANY(${relIds}::text[])`;
      for (const r of rel) visibleClaims.set(String(r.id), String(r.statement));
    }
    const visibleSegments = new Set<string>();
    if (segIds.length) {
      const segs = await tx`SELECT DISTINCT id FROM segments WHERE workspace_id = ${ws} AND id = ANY(${segIds}::text[])`;
      for (const s of segs) visibleSegments.add(String(s.id));
    }

    const entries = events.map((e) => describeEvent(claimId, e, visibleClaims, visibleSegments));
    return { claim, entries, changes: entries.filter((e) => e.kind !== "created").length };
  });
}
