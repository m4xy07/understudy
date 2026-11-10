// Relay handover: per-role compile under RLS, typed read-back, acknowledgements, export, leak check.
// Contract: docs/ARCHITECTURE.md section 4 "Review and Handover" and "Canary tests", section 5.
//
// Role-scoped reads (the snapshot's claims, the withheld counts, which read-back items a role can see)
// all run inside withRole(ws, role). Admin reads here are limited to: the snapshot header (hash,
// version, plan), responsibilities (filtered again by the core compile), resolving which snapshot claim
// answers each read-back item, and the canary token list for the leak check.
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { iso, toSnapshot } from "@/lib/db/mappers";
import { audit, getWorkspace, listGapQuestions, listResponsibilities, peopleNames } from "@/lib/db/queries";
import { getPack, roleLabel } from "@/lib/pack";
import type {
  Attribute, Citation, Claim, ReadbackItem, ReadbackVerdict, RoleKey, Scores, Snapshot, Trust,
} from "@/lib/types";
import {
  compileHandover as coreCompile, formatScores, renderMarkdown, stubText,
  type HandoverDoc, type WithheldCounts,
} from "./core/compile";
import { ackRecord, checkReadback, parseDate, type Acknowledgement } from "./core/readback";
import { scanForCanaries, surfacesOf, type Surface } from "./core/canary";
import { releaseLabel, SNAPSHOT_SCHEMA, verifySnapshot, type SnapshotPayload } from "./core/snapshot";
import { TRUST_ORDER } from "./core/labels";

// ---------------------------------------------------------------------------------------------
// Snapshot header
// ---------------------------------------------------------------------------------------------

/** Parse a stored payload; null for rows written before the core schema existed. */
export function parsePayload(v: unknown): SnapshotPayload | null {
  let p: unknown = v;
  if (typeof v === "string") {
    try { p = JSON.parse(v); } catch { return null; }
  }
  const obj = p as Partial<SnapshotPayload> | null;
  if (!obj || obj.schema !== SNAPSHOT_SCHEMA || !Array.isArray(obj.claims)) return null;
  return obj as SnapshotPayload;
}

async function latestSnapshot(ws: string): Promise<{ snapshot: Snapshot; payload: SnapshotPayload | null } | null> {
  const [row] = await db()`SELECT * FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC LIMIT 1`;
  if (!row) return null;
  return { snapshot: toSnapshot(row), payload: parsePayload(row.payload) };
}

// ---------------------------------------------------------------------------------------------
// Visible snapshot claims and withheld counts (under RLS)
// ---------------------------------------------------------------------------------------------

/** Attribute groups per handover section, passed to count_withheld(). */
export const SECTION_ATTRIBUTES: Record<keyof WithheldCounts, string> = {
  status: "owner,status,deadline,location",
  summary: "owner,status,deadline,location",
  actions: "deadline,owner,procedure,status",
  risks: "risk,dependency,access,contact",
  timeline: "decision,reason",
};

type Row = Record<string, unknown>;

function jsonArr<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string") {
    try { const p = JSON.parse(v); return Array.isArray(p) ? (p as T[]) : []; } catch { return []; }
  }
  return [];
}

function rowToClaim(ws: string, r: Row): Claim {
  return {
    id: String(r.claim_id),
    workspaceId: ws,
    entity: String(r.entity),
    entityLabel: String(r.entity_label || r.entity),
    attribute: r.attribute as Attribute,
    value: String(r.value ?? r.live_value ?? r.statement),
    statement: String(r.statement),
    citations: jsonArr<Citation>(r.citations),
    trust: r.trust as Trust,
    state: r.state === "conflicting" ? "conflicting" : "active",
    stateNote: null,
    supersededBy: null,
    roleSet: jsonArr<RoleKey>(r.role_set),
    validFrom: r.valid_from ? iso(r.valid_from) : "",
    authorId: null,
    sourceKinds: [],
    importance: (r.importance as Claim["importance"]) ?? "normal",
    tier: "B",
    review: r.review === "edited" ? "edited" : "approved",
    reviewNote: null,
    origin: "extracted",
    supportCheck: null,
  };
}

async function readVisible(ws: string, role: RoleKey, snapshotId: string): Promise<{ claims: Claim[]; counts: WithheldCounts; all: number }> {
  return withRole(ws, role, async (tx) => {
    const rows = await tx`
      SELECT sc.*, c.value AS live_value
      FROM snapshot_claims sc
      LEFT JOIN claims c ON c.workspace_id = sc.workspace_id AND c.id = sc.claim_id
      WHERE sc.workspace_id = ${ws} AND sc.snapshot_id = ${snapshotId}
      ORDER BY sc.claim_id`;
    const [w] = await tx`
      SELECT count_withheld(${ws}::uuid, ${role}, 'all') AS all_n,
             count_withheld(${ws}::uuid, ${role}, ${SECTION_ATTRIBUTES.status}) AS status_n,
             count_withheld(${ws}::uuid, ${role}, ${SECTION_ATTRIBUTES.actions}) AS actions_n,
             count_withheld(${ws}::uuid, ${role}, ${SECTION_ATTRIBUTES.risks}) AS risks_n,
             count_withheld(${ws}::uuid, ${role}, ${SECTION_ATTRIBUTES.timeline}) AS timeline_n`;
    const n = (k: string) => Number(w?.[k] ?? 0);
    return {
      claims: rows.map((r) => rowToClaim(ws, r as Row)),
      counts: { status: n("status_n"), summary: n("status_n"), actions: n("actions_n"), risks: n("risks_n"), timeline: n("timeline_n") },
      all: n("all_n"),
    };
  });
}

async function visibleSnapshotClaimIds(ws: string, role: RoleKey, snapshotId: string): Promise<Set<string>> {
  const rows = await withRole(ws, role, (tx) =>
    tx`SELECT claim_id FROM snapshot_claims WHERE workspace_id = ${ws} AND snapshot_id = ${snapshotId}`);
  return new Set(rows.map((r) => String(r.claim_id)));
}

// ---------------------------------------------------------------------------------------------
// Read-back items (admin path: which snapshot claim answers each pack item)
// ---------------------------------------------------------------------------------------------

const DATE_ONLY = /^\s*\d{4}-\d{2}-\d{2}\s*$/;
const ISO_IN = /\b(\d{4}-\d{2}-\d{2})\b/;
const CONTACT_TOKEN = /\[CONTACT:([^\]\s]+)\]/gi;
const WEEKDAYS: [RegExp, string][] = [
  [/\bmon(?:day)?s?\b/i, "Monday"],
  [/\btue(?:s|sday)?s?\b/i, "Tuesday"],
  [/\bwed(?:nesday)?s?\b/i, "Wednesday"],
  [/\bthu(?:r|rs|rsday)?s?\b/i, "Thursday"],
  [/\bfri(?:day)?s?\b/i, "Friday"],
  [/\bsat(?:urday)?s?\b/i, "Saturday"],
  [/\bsun(?:day)?s?\b/i, "Sunday"],
];

interface PackReadback { key: string; label: string; type: ReadbackItem["type"]; entity?: string; attribute?: string }

interface ResolvedClaim { claimId: string; value: string; statement: string }

export interface ResolvedReadback {
  items: ReadbackItem[];
  answers: Record<string, ResolvedClaim | null>;
}

function isDayItem(item: { key: string; label: string; type: string }): boolean {
  return item.type === "text" && (/\bday\b/i.test(item.label) || /(^|_)day$/i.test(item.key));
}

function weekday(s: string): string | null {
  const hits = WEEKDAYS.filter(([re]) => re.test(s));
  return hits.length === 1 ? hits[0][1] : null;
}

function dateRank(value: string, statement: string): number {
  if (DATE_ONLY.test(value)) return 0;
  if (parseDate(value)) return 1;
  if (ISO_IN.test(value) || ISO_IN.test(statement)) return 2;
  return 3;
}

/** For each pack read-back item, the approved snapshot claim that answers it (admin read). */
export async function resolveReadbackItems(ws: string, snapshotId: string): Promise<ResolvedReadback> {
  const pack = getPack();
  const rows = await db()`
    SELECT claim_id, entity, attribute, coalesce(value, statement) AS value, statement, trust, state, valid_from
    FROM snapshot_claims WHERE workspace_id = ${ws} AND snapshot_id = ${snapshotId}`;
  const items: ReadbackItem[] = [];
  const answers: Record<string, ResolvedClaim | null> = {};
  for (const raw of pack.readback as unknown as PackReadback[]) {
    const candidates = rows
      .filter((r) => r.entity === raw.entity && r.attribute === raw.attribute && r.state !== "conflicting")
      .map((r) => ({
        claimId: String(r.claim_id),
        value: String(r.value),
        statement: String(r.statement),
        trust: TRUST_ORDER.indexOf(r.trust as Trust),
        at: r.valid_from ? new Date(iso(r.valid_from)).getTime() : 0,
      }))
      .sort((a, b) =>
        (raw.type === "date" ? dateRank(a.value, a.statement) - dateRank(b.value, b.statement) : 0) ||
        a.trust - b.trust || b.at - a.at || (a.claimId < b.claimId ? -1 : 1));
    const best = candidates[0] ?? null;
    items.push({ key: raw.key, label: raw.label, type: raw.type, expectedClaimId: best?.claimId ?? null });
    answers[raw.key] = best ? { claimId: best.claimId, value: best.value, statement: best.statement } : null;
  }
  return { items, answers };
}

function contactName(s: string, names: Record<string, string>): string | null {
  const tokens = [...s.matchAll(CONTACT_TOKEN)];
  for (const t of tokens) {
    const name = names[t[1]];
    if (name) return name;
  }
  const stripped = s.replace(CONTACT_TOKEN, " ").replace(/\s+/g, " ").trim();
  return /[a-z]{2}/i.test(stripped) ? stripped : tokens[0]?.[0] ?? null;
}

/** The value to compare with: the first ISO date for dates, a person's name for contacts, the weekday for "day" items. */
function expectedValue(item: ReadbackItem, a: ResolvedClaim, names: Record<string, string>): string {
  switch (item.type) {
    case "date":
      return parseDate(a.value) ?? ISO_IN.exec(a.value)?.[1] ?? ISO_IN.exec(a.statement)?.[1] ?? parseDate(a.statement) ?? a.value;
    case "contact":
      return contactName(a.value, names) ?? a.value;
    case "text":
      return isDayItem(item) ? (weekday(a.value) ?? weekday(a.statement) ?? a.value) : a.value;
    case "command":
      return a.value.trim().replace(/^`+|`+$/g, "").trim();
  }
}

function typedValue(item: ReadbackItem, typed: string, names: Record<string, string>): string {
  if (item.type === "contact") {
    return typed.replace(CONTACT_TOKEN, (m, id: string) => names[id] ?? m);
  }
  if (isDayItem(item)) return weekday(typed) ?? typed;
  return typed;
}

export type ReadbackCheck =
  | { ok: true; snapshotId: string; snapshotHash: string; verdicts: ReadbackVerdict[] }
  | { ok: false; error: string };

/**
 * Typed read-back against the latest snapshot. Expected values come from the snapshot (admin path)
 * but only for items whose answering claim this role can see under RLS; the rest are "not_visible".
 */
export async function checkHandoverReadback(ws: string, role: RoleKey, typed: Record<string, string>): Promise<ReadbackCheck> {
  const latest = await latestSnapshot(ws);
  if (!latest) return { ok: false, error: "The approver hasn't approved a handover yet." };
  const { snapshot } = latest;
  const [resolved, visible, names] = await Promise.all([
    resolveReadbackItems(ws, snapshot.id),
    visibleSnapshotClaimIds(ws, role, snapshot.id),
    peopleNames(ws),
  ]);
  const expected: Record<string, string | null> = {};
  const prepared: Record<string, string> = {};
  for (const item of resolved.items) {
    const a = resolved.answers[item.key];
    expected[item.key] = a && visible.has(a.claimId) ? expectedValue(item, a, names) : null;
    prepared[item.key] = typedValue(item, String(typed[item.key] ?? "").slice(0, 500), names);
  }
  const year = Number(snapshot.approvedAt.slice(0, 4)) || undefined;
  const verdicts = checkReadback(resolved.items, prepared, expected, { year })
    .map((v) => ({ ...v, typed: String(typed[v.key] ?? "").slice(0, 500) }));
  return { ok: true, snapshotId: snapshot.id, snapshotHash: snapshot.hash, verdicts };
}

// ---------------------------------------------------------------------------------------------
// Acknowledgements (append-only)
// ---------------------------------------------------------------------------------------------

export async function acknowledgeHandover(
  ws: string, role: RoleKey, typed: Record<string, string>,
): Promise<{ ok: true; ack: Acknowledgement } | { ok: false; error: string }> {
  const pack = getPack();
  if (role === pack.leaverRole) {
    return { ok: false, error: "The leaver hands over; receipt is acknowledged by the people taking over." };
  }
  const check = await checkHandoverReadback(ws, role, typed);
  if (!check.ok) return check;
  const ack = ackRecord({ role, snapshotHash: check.snapshotHash, verdicts: check.verdicts });
  await db()`
    INSERT INTO acknowledgements (workspace_id, snapshot_id, snapshot_hash, role, verdicts, all_matched, created_at)
    VALUES (${ws}, ${check.snapshotId}, ${ack.snapshotHash}, ${role}, ${JSON.stringify(ack.verdicts)}::jsonb, ${ack.allMatched}, ${ack.at})`;
  const count = (v: ReadbackVerdict["verdict"]) => ack.verdicts.filter((x) => x.verdict === v).length;
  await audit(ws, role, "acknowledge_handover", {
    snapshotId: check.snapshotId, allMatched: ack.allMatched,
    match: count("match"), mismatch: count("mismatch"), notVisible: count("not_visible"),
  });
  return { ok: true, ack };
}

export interface AckRow {
  id: number;
  role: RoleKey;
  roleLabel: string;
  snapshotId: string;
  snapshotHash: string;
  at: string;
  allMatched: boolean;
  match: number;
  mismatch: number;
  notVisible: number;
}

export async function listAcknowledgements(ws: string): Promise<AckRow[]> {
  const pack = getPack();
  const rows = await db()`SELECT * FROM acknowledgements WHERE workspace_id = ${ws} ORDER BY created_at DESC, id DESC`;
  return rows.map((r) => {
    const verdicts = jsonArr<ReadbackVerdict>(r.verdicts);
    const n = (v: ReadbackVerdict["verdict"]) => verdicts.filter((x) => x.verdict === v).length;
    return {
      id: Number(r.id),
      role: r.role as RoleKey,
      roleLabel: roleLabel(r.role as RoleKey, pack),
      snapshotId: String(r.snapshot_id),
      snapshotHash: String(r.snapshot_hash),
      at: iso(r.created_at),
      allMatched: Boolean(r.all_matched),
      match: n("match"),
      mismatch: n("mismatch"),
      notVisible: n("not_visible"),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------------------------

export const ATTRIBUTE_ORDER: { attribute: Attribute; label: string }[] = [
  { attribute: "status", label: "Status" },
  { attribute: "owner", label: "Owners" },
  { attribute: "deadline", label: "Deadlines" },
  { attribute: "procedure", label: "How to do it" },
  { attribute: "location", label: "Where things live" },
  { attribute: "access", label: "Access (credential names only)" },
  { attribute: "contact", label: "Contacts" },
  { attribute: "dependency", label: "Dependencies" },
  { attribute: "decision", label: "Decisions" },
  { attribute: "reason", label: "Reasons" },
  { attribute: "risk", label: "Risks" },
];

export interface HandoverItem {
  claimId: string;
  entityLabel: string;
  statement: string;
  trust: Trust;
}

export interface Handover {
  role: RoleKey;
  roleLabel: string;
  approverLabel: string;
  snapshot: Snapshot | null;
  /** The I-PASS document from the core compile; null when no snapshot is approved yet. */
  doc: HandoverDoc | null;
  /** The stored payload re-hashes to the stored hash. */
  verified: boolean;
  /** Snapshot claims by attribute (the plain list view). */
  groups: { attribute: Attribute; label: string; items: HandoverItem[] }[];
  /** All withheld claims for this role, from count_withheld(..., 'all'). */
  withheld: number;
  stubLine: string | null;
  /** "Released with N open blocking gaps" (never "complete"). */
  releaseLine: string | null;
  scores: Scores | null;
}

function checkLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const list of Object.values(getPack().checklists)) for (const c of list) out[c.key] = c.label;
  return out;
}

/** The handover for one role, compiled from the latest approved snapshot under RLS. */
export async function compileHandover(ws: string, role: RoleKey): Promise<Handover> {
  const pack = getPack();
  const approverLabel = roleLabel(pack.approverRole as RoleKey, pack);
  const rl = roleLabel(role, pack);
  const latest = await latestSnapshot(ws);
  if (!latest) {
    return {
      role, roleLabel: rl, approverLabel, snapshot: null, doc: null, verified: false,
      groups: [], withheld: 0, stubLine: null, releaseLine: null, scores: null,
    };
  }
  const { snapshot, payload } = latest;
  const [{ claims, counts, all }, responsibilities, resolved] = await Promise.all([
    readVisible(ws, role, snapshot.id),
    listResponsibilities(ws),
    resolveReadbackItems(ws, snapshot.id),
  ]);
  const scores: Scores = payload?.scores ?? { b: snapshot.openBlocking, c: 0, k: null };
  const label = releaseLabel(snapshot.openBlocking);
  const doc = coreCompile({
    role,
    roleLabel: rl,
    snapshot: {
      version: snapshot.version, hash: snapshot.hash, approvedAt: snapshot.approvedAt,
      openBlocking: snapshot.openBlocking, releaseLabel: label,
    },
    visibleClaims: claims,
    withheldCounts: counts,
    scores,
    provisional: false,
    plan: snapshot.plan,
    responsibilities,
    readbackItems: resolved.items,
    checkLabels: checkLabels(),
    approverLabel,
  });
  const groups = ATTRIBUTE_ORDER.map(({ attribute, label: l }) => ({
    attribute,
    label: l,
    items: claims.filter((c) => c.attribute === attribute && c.roleSet.includes(role)).map((c) => ({
      claimId: c.id, entityLabel: c.entityLabel, statement: c.statement, trust: c.trust,
    })),
  })).filter((g) => g.items.length > 0);
  return {
    role,
    roleLabel: rl,
    approverLabel,
    snapshot,
    doc,
    verified: payload ? verifySnapshot(payload, snapshot.hash) : false,
    groups,
    withheld: all,
    stubLine: stubText(all, approverLabel),
    releaseLine: label,
    scores,
  };
}

// ---------------------------------------------------------------------------------------------
// Canary tokens and the leak check
// ---------------------------------------------------------------------------------------------

interface TokenSet {
  source: "ground_truth" | "pattern";
  all: string[];
  allowed: Map<RoleKey, Set<string>>;
}

let gtCache: { token: string; roleSet: RoleKey[] }[] | null | undefined;

function groundTruthRestricted(): { token: string; roleSet: RoleKey[] }[] | null {
  if (gtCache !== undefined) return gtCache;
  try {
    const file = path.join(process.cwd(), "data", "demo", "ground_truth.json");
    const gt = JSON.parse(fs.readFileSync(file, "utf8")) as { restricted?: { token?: string; roleSet?: RoleKey[] }[] };
    const list = (gt.restricted ?? [])
      .filter((r) => typeof r.token === "string" && Array.isArray(r.roleSet))
      .map((r) => ({ token: r.token!, roleSet: r.roleSet! }));
    gtCache = list.length ? list : null;
  } catch {
    gtCache = null;
  }
  return gtCache;
}

const CANARY_RE = /canary-[a-z0-9]+/gi;

function tokensIn(rows: readonly Row[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) for (const m of String(r.text ?? "").matchAll(CANARY_RE)) out.add(m[0].toUpperCase());
  return out;
}

/** Demo workspaces: the planted tokens from ground_truth.json. Others: any CANARY-shaped token in the sources. */
async function canaryTokens(ws: string): Promise<TokenSet> {
  const pack = getPack();
  const roles = pack.roles.map((r) => r.key as RoleKey);
  const w = await getWorkspace(ws);
  const gt = w?.kind === "demo" ? groundTruthRestricted() : null;
  if (gt) {
    const allowed = new Map<RoleKey, Set<string>>();
    for (const role of roles) allowed.set(role, new Set(gt.filter((t) => t.roleSet.includes(role)).map((t) => t.token)));
    return { source: "ground_truth", all: gt.map((t) => t.token), allowed };
  }
  const all = tokensIn(await db()`SELECT text FROM segments WHERE workspace_id = ${ws} AND text ~* 'canary-[a-z0-9]+'`);
  const allowed = new Map<RoleKey, Set<string>>();
  for (const role of roles) {
    const rows = await withRole(ws, role, (tx) =>
      tx`SELECT text FROM segments WHERE workspace_id = ${ws} AND text ~* 'canary-[a-z0-9]+'`);
    allowed.set(role, tokensIn(rows as unknown as Row[]));
  }
  return { source: "pattern", all: [...all], allowed };
}

/** The Markdown export for one role: the same compile, rendered, and refused if it would leak. */
export async function exportMarkdown(
  ws: string, role: RoleKey,
): Promise<{ ok: true; markdown: string; filename: string } | { ok: false; status: number; error: string }> {
  const h = await compileHandover(ws, role);
  if (!h.doc || !h.snapshot) {
    return { ok: false, status: 404, error: "The approver hasn't approved a handover yet. Switch to Club President and go to Review." };
  }
  const markdown = renderMarkdown(h.doc);
  const tokens = await canaryTokens(ws);
  const leaks = scanForCanaries([{ surface: "export", text: markdown }], tokens.allowed.get(role) ?? new Set(), tokens.all);
  if (leaks.length) {
    await audit(ws, "system", "export_blocked", { role, leaks: leaks.length });
    return { ok: false, status: 500, error: "Export blocked: the leak check found a restricted token in this export." };
  }
  await audit(ws, role, "export_handover", { snapshotId: h.snapshot.id, version: h.snapshot.version });
  return { ok: true, markdown, filename: `handover-${role}-v${h.snapshot.version}.md` };
}

export const LEAK_SURFACES = ["handover", "export", "stubs", "scores", "timeline", "questions"] as const;
export type LeakSurface = (typeof LEAK_SURFACES)[number];

export interface LeakCell {
  role: RoleKey;
  surface: LeakSurface;
  texts: number;
  leaks: number;
}

export interface LeakReport {
  source: "ground_truth" | "pattern";
  tokenCount: number;
  compiled: boolean;
  roles: { key: RoleKey; label: string; maySee: number }[];
  surfaces: readonly LeakSurface[];
  cells: LeakCell[];
  allPass: boolean;
}

function surfaceOf(name: string): LeakSurface {
  if (name === "handover:timeline" || name === "timeline") return "timeline";
  if (name.startsWith("handover:")) return "handover";
  return name as LeakSurface;
}

/**
 * Run scanForCanaries over every surface for every role: handover text, export, stubs, scores,
 * timeline and gap questions. A token may only appear for roles allowed to see it.
 */
export async function runLeakCheck(ws: string): Promise<LeakReport> {
  const pack = getPack();
  const tokens = await canaryTokens(ws);
  const questions = (await listGapQuestions(ws)).map((q) => q.text);
  const roles = pack.roles.map((r) => r.key as RoleKey);
  const cells: LeakCell[] = [];
  let compiled = false;
  for (const role of roles) {
    const h = await compileHandover(ws, role);
    const texts: Surface[] = [];
    if (h.doc) {
      compiled = true;
      const stubs = h.doc.sections.flatMap((s) => s.lines.filter((l) => l.kind === "stub").map((l) => l.text));
      if (h.stubLine) stubs.push(h.stubLine);
      const timeline = h.doc.sections.find((s) => s.key === "timeline")?.lines.map((l) => l.text) ?? [];
      const scores = h.scores ? [formatScores(h.scores), h.doc.snapshot.releaseLabel] : [h.doc.snapshot.releaseLabel];
      texts.push(...surfacesOf(h.doc, { stubs, scores, timeline, questions, export: renderMarkdown(h.doc) }));
      for (const g of h.groups) for (const it of g.items) texts.push({ surface: "handover:groups", text: `${it.entityLabel} ${it.statement}` });
    } else {
      for (const q of questions) texts.push({ surface: "questions", text: q });
    }
    const leaks = scanForCanaries(texts, tokens.allowed.get(role) ?? new Set(), tokens.all);
    for (const surface of LEAK_SURFACES) {
      cells.push({
        role,
        surface,
        texts: texts.filter((t) => surfaceOf(t.surface) === surface).length,
        leaks: leaks.filter((l) => surfaceOf(l.surface) === surface).length,
      });
    }
  }
  return {
    source: tokens.source,
    tokenCount: tokens.all.length,
    compiled,
    roles: roles.map((key) => ({ key, label: roleLabel(key, pack), maySee: tokens.allowed.get(key)?.size ?? 0 })),
    surfaces: LEAK_SURFACES,
    cells,
    allPass: cells.every((c) => c.leaks === 0),
  };
}
