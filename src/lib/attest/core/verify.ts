// Attest verifier: turns drafts (model output or structured rows) into Claims.
// Contract: docs/ARCHITECTURE.md section 4 "Claims (Attest)". Pure: no DB, no model, no network.
//
// Rules applied here, exactly:
// - a citation is accepted iff its segment exists AND was in the batch the model saw
//   (structured drafts: the segment exists);
// - a citation is exact iff a quote is given and norm(quote) is a substring of norm(segment.text);
// - trust from_record iff at least one accepted exact citation, else inferred if any accepted
//   citation, else the draft is dropped and counted against its source;
// - claim role set = intersection of the accepted cited segments' role sets;
// - validFrom / authorId = time / author of the newest accepted cited segment.
// `locateSpan` is for reviewers only: it never accepts a citation or sets a label.
import type {
  Attribute,
  Citation,
  Claim,
  ResponsibilityKind,
  RoleKey,
  Segment,
  SourceKind,
  Trust,
} from "@/lib/types";
import { norm, sha256Hex } from "@/lib/text/norm";
import { isWrittenDateDeadline } from "../dates";

export const ATTRIBUTES: readonly Attribute[] = [
  "owner", "status", "deadline", "location", "procedure", "access",
  "decision", "reason", "dependency", "contact", "risk",
];

/** Draft claim as produced by the extraction step (model or structured rows). */
export interface DraftClaim {
  entity: string;
  attribute: Attribute;
  value: string;
  statement: string;
  citations: { segment_id: string; quote: string | null }[];
  batchId: string;
  batchSegmentIds: string[];
  origin: "extracted" | "structured";
}

/**
 * The parts of the setting pack (ARCHITECTURE 1a) the Attest core reads. Structural, so the
 * foundation's zod-inferred pack type is assignable to it.
 */
export interface AttestPack {
  entities?: { key: string; label: string; aliases?: string[] }[];
  sourceAuthority: Partial<Record<Attribute, Partial<Record<SourceKind, number>>>>;
  checklists?: Partial<Record<ResponsibilityKind, { key: string; weight: number; attributes: Attribute[] }[]>>;
  roleTemplates?: Partial<Record<string, { key: string; kind: ResponsibilityKind; entities: string[] }[]>>;
  /** Canonical order of a role set: the order of the pack's roles. */
  roleOrder: readonly RoleKey[];
  /** Roles the pack flags "sees least": a claim hidden from any of them is sensitive (tier C). */
  restrictedAudience: readonly RoleKey[];
}

export interface DroppedDraft {
  draft: DraftClaim;
  reason: string;
  sourceId: string;
}

export interface VerifyResult {
  claims: Claim[];
  dropped: DroppedDraft[];
  droppedBySource: Record<string, number>;
}

/** Deterministic claim id: clm_ + 16 hex of sha256(entity|attribute|norm(value)|sorted segment ids). */
export function claimId(entity: string, attribute: Attribute, value: string, segmentIds: string[]): string {
  const ids = [...new Set(segmentIds)].sort();
  return "clm_" + sha256Hex([entity, attribute, norm(value), ids.join(",")].join("|")).slice(0, 16);
}

/** The exact-quote test: norm(quote) must be a non-empty substring of norm(segmentText). */
export function isExactQuote(quote: string | null | undefined, segmentText: string): boolean {
  if (quote == null) return false;
  const q = norm(quote);
  if (q.length === 0) return false;
  return norm(segmentText).includes(q);
}

/** Map a draft entity onto a pack entity key (by key, label or alias); unknown entities are slugged. */
export function resolveEntity(raw: string, pack: Pick<AttestPack, "entities">): { key: string; label: string } {
  const n = norm(raw);
  const entities = pack.entities ?? [];
  const byKey = entities.find((e) => norm(e.key) === n);
  if (byKey) return { key: byKey.key, label: byKey.label };
  const byName = entities.find((e) => norm(e.label) === n || (e.aliases ?? []).some((a) => norm(a) === n));
  if (byName) return { key: byName.key, label: byName.label };
  const slug = n.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return { key: slug || "other", label: raw.trim() || "Other" };
}

/** Intersection of role sets, in the pack's role order (`order` = pack.roleOrder). */
export function intersectRoleSets(sets: RoleKey[][], order: readonly RoleKey[]): RoleKey[] {
  if (sets.length === 0) return [];
  return order.filter((r) => sets.every((s) => s.includes(r)));
}

function timeOf(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

/** Newest segment by timestamp, ties broken by position then id (deterministic). */
export function newestSegment(segs: Segment[]): Segment {
  return segs.reduce((best, s) => {
    const d = timeOf(s.ts) - timeOf(best.ts);
    if (d !== 0) return d > 0 ? s : best;
    if (s.position !== best.position) return s.position > best.position ? s : best;
    return s.id > best.id ? s : best;
  });
}

function sourceOfDraft(draft: DraftClaim, segmentsById: Map<string, Segment>): string {
  for (const c of draft.citations ?? []) {
    const seg = segmentsById.get(c.segment_id);
    if (seg) return seg.sourceId;
  }
  for (const id of draft.batchSegmentIds ?? []) {
    const seg = segmentsById.get(id);
    if (seg) return seg.sourceId;
  }
  return "unknown";
}

function trustFromCitations(citations: Citation[]): Trust | null {
  if (citations.some((c) => c.accepted && c.exact)) return "from_record";
  if (citations.some((c) => c.accepted)) return "inferred";
  return null;
}

function mergeCitations(a: Citation[], b: Citation[]): Citation[] {
  const out = a.map((c) => ({ ...c }));
  for (const c of b) {
    const same = out.find((x) => x.segmentId === c.segmentId && x.quote === c.quote);
    if (same) {
      same.accepted = same.accepted || c.accepted;
      same.exact = same.exact || c.exact;
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

export function verifyDrafts(
  drafts: DraftClaim[],
  segmentsById: Map<string, Segment>,
  pack: Pick<AttestPack, "entities" | "roleOrder">,
  workspaceId: string,
): VerifyResult {
  const claims = new Map<string, Claim>();
  const dropped: DroppedDraft[] = [];
  const droppedBySource: Record<string, number> = {};

  const drop = (draft: DraftClaim, reason: string) => {
    const sourceId = sourceOfDraft(draft, segmentsById);
    dropped.push({ draft, reason, sourceId });
    droppedBySource[sourceId] = (droppedBySource[sourceId] ?? 0) + 1;
  };

  for (const draft of drafts) {
    if (!ATTRIBUTES.includes(draft.attribute)) {
      drop(draft, `unknown attribute "${String(draft.attribute)}"`);
      continue;
    }
    if (!draft.value || !draft.value.trim()) {
      drop(draft, "empty value");
      continue;
    }

    const batch = new Set(draft.batchSegmentIds ?? []);
    const citations: Citation[] = [];
    const reasons = new Set<string>();
    const seen = new Set<string>();
    for (const c of draft.citations ?? []) {
      const quote = c.quote ?? null;
      const key = `${c.segment_id}\u0000${quote ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const seg = segmentsById.get(c.segment_id);
      const inBatch = draft.origin === "structured" || batch.has(c.segment_id);
      if (!seg) reasons.add("cited segment not found");
      else if (!inBatch) reasons.add("cited segment was not in the batch the model saw");
      citations.push({
        segmentId: c.segment_id,
        quote,
        accepted: !!seg && inBatch,
        exact: !!seg && isExactQuote(quote, seg.text),
      });
    }

    const trust = trustFromCitations(citations);
    if (trust === null) {
      drop(draft, citations.length === 0 ? "no citations" : `no accepted citation (${[...reasons].join("; ")})`);
      continue;
    }

    const acceptedIds = [...new Set(citations.filter((c) => c.accepted).map((c) => c.segmentId))];
    const segs = acceptedIds.map((id) => segmentsById.get(id) as Segment);
    // A model deadline that is only the day its source was written (a header time read as an
    // event date). Board and calendar rows are exempt: their dates are fields, not prose.
    if (
      draft.attribute === "deadline" &&
      draft.origin !== "structured" &&
      isWrittenDateDeadline(
        draft.value,
        segs.map((s) => ({ ts: s.ts, text: s.text, quote: citations.find((c) => c.segmentId === s.id && c.accepted)?.quote ?? null })),
      )
    ) {
      drop(draft, "deadline is the date the cited text was written; the text states no such date");
      continue;
    }
    const newest = newestSegment(segs);
    const { key: entity, label: entityLabel } = resolveEntity(draft.entity, pack);
    const value = draft.value.trim();
    const id = claimId(entity, draft.attribute, value, acceptedIds);

    const existing = claims.get(id);
    if (existing) {
      // Exact duplicate (same entity, attribute, value and evidence): merge citations.
      existing.citations = mergeCitations(existing.citations, citations);
      existing.trust = trustFromCitations(existing.citations) ?? existing.trust;
      continue;
    }

    claims.set(id, {
      id,
      workspaceId,
      entity,
      entityLabel,
      attribute: draft.attribute,
      value,
      statement: draft.statement.trim(),
      citations,
      trust,
      state: "active",
      stateNote: null,
      supersededBy: null,
      roleSet: intersectRoleSets(segs.map((s) => s.roleSet), pack.roleOrder),
      validFrom: newest.ts,
      authorId: newest.authorId,
      sourceKinds: [...new Set(segs.map((s) => s.sourceKind))].sort(),
      importance: "normal",
      tier: "B",
      review: "pending",
      reviewNote: null,
      origin: draft.origin,
      supportCheck: null,
    });
  }

  return { claims: [...claims.values()], dropped, droppedBySource };
}

// ---------------------------------------------------------------------------------------------
// Reviewer aid: best approximate span. NEVER used to accept a citation or to set trust.

export interface Span {
  start: number;     // char offset in segmentText
  end: number;       // exclusive
  score: number;     // 0..1 token-overlap similarity (1 = literal match)
  literal: boolean;  // true when the quote occurs literally (case-insensitive)
}

interface Tok { t: string; start: number; end: number }

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({ t: m[0].normalize("NFKC").toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Find where a quote most likely sits in the segment, for highlighting in review.
 * Literal (case-insensitive) match first; otherwise the token window (length n-2..n+2) with the
 * best multiset-overlap F1 against the quote's tokens. Returns null when nothing overlaps.
 */
export function locateSpan(quote: string | null | undefined, segmentText: string): Span | null {
  if (!quote || !quote.trim()) return null;
  const q = quote.trim();
  const idx = segmentText.toLowerCase().indexOf(q.toLowerCase());
  if (idx >= 0) return { start: idx, end: idx + q.length, score: 1, literal: true };

  const qt = tokenize(q).map((x) => x.t);
  const st = tokenize(segmentText);
  if (qt.length === 0 || st.length === 0) return null;
  const qCount = new Map<string, number>();
  for (const t of qt) qCount.set(t, (qCount.get(t) ?? 0) + 1);

  let best: { i: number; w: number; score: number } | null = null;
  const n = qt.length;
  for (let w = Math.max(1, n - 2); w <= Math.min(st.length, n + 2); w++) {
    for (let i = 0; i + w <= st.length; i++) {
      const remaining = new Map(qCount);
      let overlap = 0;
      for (let k = i; k < i + w; k++) {
        const left = remaining.get(st[k].t) ?? 0;
        if (left > 0) {
          overlap++;
          remaining.set(st[k].t, left - 1);
        }
      }
      const score = (2 * overlap) / (n + w);
      if (!best || score > best.score + 1e-9) best = { i, w, score };
    }
  }
  if (!best || best.score === 0) return null;
  return { start: st[best.i].start, end: st[best.i + best.w - 1].end, score: best.score, literal: false };
}
