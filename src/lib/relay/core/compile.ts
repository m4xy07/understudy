// Per-role handover compile (Relay). Pure: fixed templates only, no model rewrites handover text.
// Claims arrive already filtered by RLS (withRole); this file only drops, defensively, any claim whose
// role set lacks the role and records it as a violation. Contract: docs/ARCHITECTURE.md section 4.
import type {
  Attribute, Claim, PlanItem, ReadbackItem, Responsibility, RoleKey, Scores, Trust,
} from "@/lib/types";
import {
  ATTRIBUTE_LABEL, OPEN_GAPS_NOTE, REVIEWER_EDITED_LABEL, TRUST_LABEL, weakestTrust,
} from "./labels";
import { parseDate } from "./readback";
import { isReviewerEdited } from "./review";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type HandoverSectionKey =
  | "status" | "summary" | "actions" | "risks" | "synthesis" | "timeline" | "open_items";

export type HandoverLineKind =
  | "status" | "claim" | "action" | "plan" | "conflict" | "access" | "readback" | "stub" | "empty";

/** One rendered line. Every line carries trust (null for non-claim lines), claim ids and segment ids. */
export interface HandoverLine {
  text: string;
  trust: Trust | null;
  claimIds: string[];
  segmentIds: string[];
  kind: HandoverLineKind;
  /** True when any claim behind the line was edited by the reviewer. */
  edited: boolean;
  /** ISO date for action and plan lines (used for sorting), else null. */
  date: string | null;
}

export interface HandoverSection {
  key: HandoverSectionKey;
  /** I-PASS letter; null for the extra sections (timeline, open items). */
  letter: "I" | "P" | "A" | "S" | null;
  title: string;
  lines: HandoverLine[];
  /** Restricted items withheld from this section (the stub line is already in `lines`). */
  withheld: number;
}

export interface HandoverSnapshotMeta {
  version: number;
  hash: string;
  approvedAt: string;
  openBlocking: number;
  releaseLabel: string;
}

export interface ReadbackFormItem {
  key: string;
  label: string;
  type: ReadbackItem["type"];
  hint: string;
}

export interface RoleViolation {
  claimId: string;
  reason: "role_not_in_role_set";
}

export interface HandoverDoc {
  role: RoleKey;
  roleLabel: string;
  snapshot: HandoverSnapshotMeta;
  /** I-PASS order: status, summary, actions, risks, synthesis; then timeline and open items. */
  sections: HandoverSection[];
  /** The read-back form: only items this role can see. */
  readbackForm: ReadbackFormItem[];
  /** Claims that reached compile although their role set lacks this role. Dropped, never rendered. */
  violations: RoleViolation[];
}

export interface WithheldCounts {
  status: number;
  summary: number;
  actions: number;
  risks: number;
  timeline: number;
}

export interface CompileInput {
  role: RoleKey;
  roleLabel: string;
  snapshot: HandoverSnapshotMeta;
  visibleClaims: readonly Claim[];
  /** Numbers only, from count_withheld(). */
  withheldCounts: WithheldCounts;
  scores: Scores;
  provisional?: boolean;
  plan: readonly PlanItem[];
  responsibilities: readonly Responsibility[];
  /**
   * The pack's critical read-back items, with expectedClaimId resolved by the admin path. An id that is
   * not among the visible claims counts as restricted; a null id means nothing was approved for it.
   */
  readbackItems?: readonly ReadbackItem[];
  /** Check key -> label from the pack; falls back to the key in words. */
  checkLabels?: Readonly<Record<string, string>>;
  /** The approver's label from the pack (roleLabel(pack.approverRole, pack)). */
  approverLabel: string;
}

// ---------------------------------------------------------------------------------------------
// Fixed text
// ---------------------------------------------------------------------------------------------

/** Exact stub text: "N restricted items. Ask the approver (<approver label>)." Singular for 1; null for 0. */
export function stubText(n: number, approverLabel: string): string | null {
  const count = Number.isFinite(n) ? Math.floor(n) : 0;
  if (count <= 0) return null;
  const items = count === 1 ? "1 restricted item." : `${count} restricted items.`;
  return `${items} Ask the approver (${approverLabel}).`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "B 1 · C 91% · K 50%" (K "n/a" when nothing is covered). Never one percentage. */
export function formatScores(scores: Scores): string {
  return `B ${scores.b} · C ${pct(scores.c)} · K ${scores.k === null ? "n/a" : pct(scores.k)}`;
}

export const SECTION_TITLES: Record<HandoverSectionKey, { letter: HandoverSection["letter"]; title: string }> = {
  status: { letter: "I", title: "Workstream status" },
  summary: { letter: "P", title: "Project summary" },
  actions: { letter: "A", title: "Action list" },
  risks: { letter: "S", title: "Situation awareness and contingency" },
  synthesis: { letter: "S", title: "Synthesis by receiver" },
  timeline: { letter: null, title: "Decision timeline" },
  open_items: { letter: null, title: "Open items" },
};

const SECTION_ORDER: HandoverSectionKey[] = ["status", "summary", "actions", "risks", "synthesis", "timeline", "open_items"];

const EMPTY_TEXT: Partial<Record<HandoverSectionKey, string>> = {
  summary: "No approved responsibilities visible to this role.",
  actions: "No dated actions on record.",
  risks: "No risks, dependencies, disagreements or access needs on record.",
  synthesis: "No read-back items for this role.",
  timeline: "No decisions on record.",
  open_items: "No open blocking gaps.",
};

const READBACK_HINT: Record<ReadbackItem["type"], string> = {
  date: "A date, e.g. 28 Nov 2026",
  text: "Type it as written in the handover",
  contact: "The contact's name or token",
  command: "The exact command",
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function segmentIdsOf(claims: readonly Claim[]): string[] {
  return uniq(claims.flatMap((c) => c.citations.filter((x) => x.accepted).map((x) => x.segmentId)));
}

function claimLine(kind: HandoverLineKind, text: string, claims: readonly Claim[], date: string | null = null): HandoverLine {
  const edited = claims.some(isReviewerEdited);
  return {
    text: edited ? `${text} (${REVIEWER_EDITED_LABEL})` : text,
    trust: weakestTrust(claims.map((c) => c.trust)),
    claimIds: claims.map((c) => c.id),
    segmentIds: segmentIdsOf(claims),
    kind,
    edited,
    date,
  };
}

function plainLine(kind: HandoverLineKind, text: string, date: string | null = null): HandoverLine {
  return { text, trust: null, claimIds: [], segmentIds: [], kind, edited: false, date };
}

function humanise(key: string): string {
  const s = key.replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : key;
}

function stripStop(s: string): string {
  return s.trim().replace(/[.\s]+$/, "");
}

/** Active values for one attribute on one entity, plus whether that attribute is disputed. */
function pick(claims: readonly Claim[], attribute: Attribute): { value: string | null; used: Claim[]; disputed: boolean } {
  const active = claims.filter((c) => c.attribute === attribute && c.state === "active");
  const disputed = claims.some((c) => c.attribute === attribute && c.state === "conflicting");
  if (active.length) return { value: uniq(active.map((c) => stripStop(c.value))).join(" and "), used: active, disputed };
  return { value: null, used: [], disputed };
}

// ---------------------------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------------------------

export function compileHandover(input: CompileInput): HandoverDoc {
  const { role, snapshot, scores } = input;
  const approver = input.approverLabel;
  const askApprover = `Ask the approver (${approver}).`;
  const checkLabel = (key: string) => input.checkLabels?.[key] ?? humanise(key);
  const yearMatch = /^(\d{4})/.exec(snapshot.approvedAt ?? "");
  const year = yearMatch ? Number(yearMatch[1]) : undefined;

  // Defensive role filter: never render a claim whose role set lacks this role.
  const violations: RoleViolation[] = [];
  const claims: Claim[] = [];
  for (const c of input.visibleClaims) {
    if (!c.roleSet.includes(role)) {
      violations.push({ claimId: c.id, reason: "role_not_in_role_set" });
      continue;
    }
    if (c.state === "dropped" || c.state === "superseded" || c.review === "rejected") continue;
    claims.push(c);
  }
  claims.sort((a, b) => byStr(a.id, b.id));

  const byEntity = new Map<string, Claim[]>();
  for (const c of claims) {
    const list = byEntity.get(c.entity) ?? [];
    list.push(c);
    byEntity.set(c.entity, list);
  }
  const entityLabel = (entity: string) => byEntity.get(entity)?.[0]?.entityLabel ?? entity;

  // A responsibility is shown only when this role sees a claim on it, or it comes from the pack's
  // role template (pack text, not source text). Others are never named.
  const visibleResp = [...input.responsibilities]
    .filter((r) => r.origin === "role_template" || r.entities.some((e) => byEntity.has(e)))
    .sort((a, b) => byStr(a.key, b.key) || byStr(a.id, b.id));
  const respById = new Map(visibleResp.map((r) => [r.id, r]));

  const sections = new Map<HandoverSectionKey, { lines: HandoverLine[]; withheld: number }>();
  for (const key of SECTION_ORDER) sections.set(key, { lines: [], withheld: 0 });
  const put = (key: HandoverSectionKey, line: HandoverLine) => sections.get(key)!.lines.push(line);

  // I: Workstream status ------------------------------------------------------------------
  put("status", plainLine("status", snapshot.releaseLabel));
  put("status", plainLine(
    "status",
    `Snapshot v${snapshot.version} · approved ${(snapshot.approvedAt ?? "").slice(0, 10)} · sha256 ${snapshot.hash.slice(0, 12)}`,
  ));
  put("status", plainLine("status", formatScores(scores)));
  if (snapshot.openBlocking !== scores.b) put("status", plainLine("status", OPEN_GAPS_NOTE));
  if (input.provisional) put("status", plainLine("status", "Scores are provisional until review."));
  sections.get("status")!.withheld = input.withheldCounts.status;

  // P: Project summary --------------------------------------------------------------------
  for (const r of visibleResp) {
    const rc = r.entities.flatMap((e) => byEntity.get(e) ?? []);
    const owner = pick(rc, "owner");
    const status = pick(rc, "status");
    const deadline = pick(rc, "deadline");
    const used = [...owner.used, ...status.used, ...deadline.used];
    const part = (label: string, p: ReturnType<typeof pick>, none: string) =>
      `${label} ${p.value ?? (p.disputed ? "disputed (see Situation awareness)" : none)}`;
    const text = `${r.key} ${r.title}: ${part("owner", owner, "not named")}; ${part("status", status, "not recorded")}; ${part("due", deadline, "no date")}.`;
    put("summary", used.length ? claimLine("claim", text, used) : plainLine("claim", text));
  }
  sections.get("summary")!.withheld = input.withheldCounts.summary;

  // A: Action list ------------------------------------------------------------------------
  const actions: HandoverLine[] = [];
  for (const [entity, ec] of byEntity) {
    const owner = pick(ec, "owner");
    const status = pick(ec, "status");
    for (const d of ec.filter((c) => c.attribute === "deadline" && c.state === "active")) {
      const iso = parseDate(d.value, year);
      const text = `Due ${iso ?? stripStop(d.value)}: ${entityLabel(entity)}. Owner: ${owner.value ?? "not named"}. Status: ${status.value ?? "not recorded"}.`;
      actions.push(claimLine("action", text, [d, ...owner.used, ...status.used], iso));
    }
    const disputed = ec.filter((c) => c.attribute === "deadline" && c.state === "conflicting");
    if (disputed.length) {
      actions.push(claimLine("action", `Date not settled: ${entityLabel(entity)}. Sources disagree; see Situation awareness.`, disputed));
    }
  }
  const visiblePlan: PlanItem[] = [];
  let hiddenPlan = 0;
  for (const p of input.plan) {
    if (respById.has(p.responsibilityId)) visiblePlan.push(p);
    else hiddenPlan++;
  }
  for (const p of visiblePlan) {
    const r = respById.get(p.responsibilityId)!;
    const iso = parseDate(p.dueDate, year);
    actions.push(plainLine(
      "plan",
      `Due ${iso ?? p.dueDate}: close the gap "${checkLabel(p.checkKey)}" on ${r.key} ${r.title}. Owner: ${p.owner}.`,
      iso,
    ));
  }
  actions.sort((a, b) => {
    if (a.date && b.date) return byStr(a.date, b.date) || byStr(a.text, b.text);
    if (a.date) return -1;
    if (b.date) return 1;
    return byStr(a.text, b.text);
  });
  sections.get("actions")!.lines.push(...actions);
  // Next steps: how each thing is done (undated, after the dated actions).
  for (const c of claims.filter((x) => x.attribute === "procedure" && x.state === "active")) {
    put("actions", claimLine("claim", `How to (${c.entityLabel}): ${c.statement}`, [c]));
  }
  sections.get("actions")!.withheld = input.withheldCounts.actions;

  // S: Situation awareness and contingency -------------------------------------------------
  for (const c of claims.filter((x) => x.attribute === "risk" && x.state === "active")) {
    put("risks", claimLine("claim", `Risk: ${c.statement}`, [c]));
  }
  for (const c of claims.filter((x) => x.attribute === "dependency" && x.state === "active")) {
    put("risks", claimLine("claim", `Dependency: ${c.statement}`, [c]));
  }
  const conflictGroups = new Map<string, Claim[]>();
  for (const c of claims.filter((x) => x.state === "conflicting")) {
    const k = `${c.entity}\u0000${c.attribute}`;
    conflictGroups.set(k, [...(conflictGroups.get(k) ?? []), c]);
  }
  for (const k of [...conflictGroups.keys()].sort(byStr)) {
    const group = conflictGroups.get(k)!;
    const first = group[0];
    const what = `${first.entityLabel} ${ATTRIBUTE_LABEL[first.attribute]}`;
    const values = uniq(group.map((c) => `"${stripStop(c.value)}"`));
    const text = values.length >= 2
      ? `Two sources disagree: ${what} is ${values.join(" or ")}. ${askApprover}`
      : `Sources disagree: ${what} ${values[0]} is disputed. ${askApprover}`;
    put("risks", claimLine("conflict", text, group));
  }
  for (const c of claims.filter((x) => x.attribute === "access" && x.state === "active")) {
    // Access claims hold credential names only (values are masked before storage).
    put("risks", claimLine("access", `Access: ${c.entityLabel} needs the credential named ${stripStop(c.value)}.`, [c]));
  }
  for (const c of claims.filter((x) => x.attribute === "location" && x.state === "active")) {
    put("risks", claimLine("claim", `Where (${c.entityLabel}): ${c.statement}`, [c]));
  }
  for (const c of claims.filter((x) => x.attribute === "contact" && x.state === "active")) {
    put("risks", claimLine("claim", `Contact (${c.entityLabel}): ${c.statement}`, [c]));
  }
  sections.get("risks")!.withheld = input.withheldCounts.risks;

  // S: Synthesis by receiver (read-back form) ----------------------------------------------
  const visibleIds = new Set(claims.map((c) => c.id));
  const readbackForm: ReadbackFormItem[] = [];
  let hiddenReadback = 0;
  for (const item of input.readbackItems ?? []) {
    if (item.expectedClaimId !== null && !visibleIds.has(item.expectedClaimId)) {
      hiddenReadback++;
      continue;
    }
    readbackForm.push({ key: item.key, label: item.label, type: item.type, hint: READBACK_HINT[item.type] });
    put("synthesis", plainLine(
      "readback",
      item.expectedClaimId === null
        ? `Read back: ${item.label}. No approved claim for this yet. The approver can approve it on Review.`
        : `Read back: ${item.label}.`,
    ));
  }
  sections.get("synthesis")!.withheld = hiddenReadback;

  // Decision timeline ------------------------------------------------------------------------
  const timeline = claims
    .filter((c) => (c.attribute === "decision" || c.attribute === "reason") && c.state !== "superseded")
    .sort((a, b) =>
      byStr(a.validFrom, b.validFrom) ||
      (a.attribute === b.attribute ? 0 : a.attribute === "decision" ? -1 : 1) ||
      byStr(a.id, b.id));
  for (const c of timeline) {
    const label = c.attribute === "decision" ? "Decision" : "Reason";
    const disputed = c.state === "conflicting" ? " (disputed)" : "";
    put("timeline", claimLine("claim", `${c.validFrom.slice(0, 10)} · ${label}: ${c.statement}${disputed}`, [c], c.validFrom.slice(0, 10)));
  }
  sections.get("timeline")!.withheld = input.withheldCounts.timeline;

  // Open items -------------------------------------------------------------------------------
  const openPlan = [...visiblePlan].sort((a, b) =>
    byStr(parseDate(a.dueDate, year) ?? a.dueDate, parseDate(b.dueDate, year) ?? b.dueDate) ||
    byStr(a.responsibilityId, b.responsibilityId) || byStr(a.checkKey, b.checkKey));
  for (const p of openPlan) {
    const r = respById.get(p.responsibilityId)!;
    const iso = parseDate(p.dueDate, year);
    put("open_items", plainLine(
      "plan",
      `${r.key} ${r.title}: ${checkLabel(p.checkKey)}. Owner: ${p.owner}. Due ${iso ?? p.dueDate}. Risk: ${stripStop(p.riskNote)}.`,
      iso,
    ));
  }
  sections.get("open_items")!.withheld = hiddenPlan;

  // Stubs and empty notes ---------------------------------------------------------------------
  const out: HandoverSection[] = SECTION_ORDER.map((key) => {
    const s = sections.get(key)!;
    const withheld = Number.isFinite(s.withheld) ? Math.max(0, Math.floor(s.withheld)) : 0;
    const lines = [...s.lines];
    const stub = stubText(withheld, approver);
    if (stub) lines.push(plainLine("stub", stub));
    else if (lines.length === 0 && EMPTY_TEXT[key]) lines.push(plainLine("empty", EMPTY_TEXT[key]!));
    return { key, letter: SECTION_TITLES[key].letter, title: SECTION_TITLES[key].title, lines, withheld };
  });

  return {
    role,
    roleLabel: input.roleLabel,
    snapshot: { ...snapshot },
    sections: out,
    readbackForm,
    violations,
  };
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

/** Markdown export of the same doc: trust labels in words, citations as [^seg_…] footnotes. */
export function renderMarkdown(doc: HandoverDoc): string {
  const out: string[] = [];
  const footnotes: string[] = [];
  const seen = new Set<string>();
  out.push(`# Handover for ${doc.roleLabel}`);
  out.push("");
  out.push(`${doc.snapshot.releaseLabel}. Snapshot v${doc.snapshot.version}, approved ${doc.snapshot.approvedAt}.`);
  out.push(`SHA-256: ${doc.snapshot.hash}`);
  for (const s of doc.sections) {
    out.push("");
    out.push(s.letter ? `## ${s.letter} · ${s.title}` : `## ${s.title}`);
    out.push("");
    for (const line of s.lines) {
      let md = `- ${line.text}`;
      if (line.trust) md += ` (${TRUST_LABEL[line.trust]})`;
      for (const seg of line.segmentIds) {
        md += `[^${seg}]`;
        if (!seen.has(seg)) {
          seen.add(seg);
          footnotes.push(`[^${seg}]: Evidence segment ${seg}`);
        }
      }
      out.push(md);
    }
  }
  if (footnotes.length) {
    out.push("");
    out.push("---");
    out.push("");
    out.push(...footnotes);
  }
  return out.join("\n") + "\n";
}
