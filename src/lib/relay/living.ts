// Living handover: findings after release (database layer over ./core/finding and ./core/changes).
// Spec: docs/round3/specs/03_living_handover_second_setting.md part B; decisions in docs/round3/DECISIONS.md.
//
//   firstWeeks(ws, role)                    -> the First weeks page: open gaps as a checklist, role-scoped
//   listOpenGaps(ws, role)                  -> the rows of that checklist
//   listFindings(ws, role)                  -> findings the role may see (read inside withRole)
//   recordFinding(ws, actor, form)          -> the successor records one; nothing moves yet
//   withdrawFinding(ws, actor, findingId)   -> the successor takes a pending one back
//   decideFinding(ws, actor, id, decision)  -> the approver approves (re-test, next snapshot) or rejects
//   whatChanged(ws, role, snapshotId)       -> the "What changed in v{n}" panel for one role
//   changeTexts(ws, role)                   -> every string those panels show the role (leak grid)
//   firstWeeksTexts(ws, role)               -> every string the First weeks page shows the role (leak grid)
//
// Rules: only the successor records; only the approver decides and the leaver never; text is masked
// before storage; the role set only narrows; trust is successor_found, set by code; a pending
// finding moves no score, no handover and no claim_meta result; one snapshot per approved finding;
// when the release rule blocks that snapshot the finding stays approved and the snapshot waits.
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db/client";
import { toClaim, toSnapshot } from "@/lib/db/mappers";
import { audit, getLatestTestRun, getWorkspace, listPlanItems, listResponsibilities } from "@/lib/db/queries";
import { withRole } from "@/lib/db/withRole";
import { claimId as makeClaimId, rerunRules, tierFor } from "@/lib/attest";
import { comparable } from "@/lib/attest/core/rules";
import { runTest, toLacunaPack, workspaceNow, type RunTestOptions } from "@/lib/lacuna";
import { checksByResp, findCheck } from "@/lib/lacuna/core/checks";
import type { LacunaCheck } from "@/lib/lacuna/core/pack";
import { approvalRoles, entityLabel, getWorkspacePack, roleLabel, type ResolvedPack } from "@/lib/pack";
import { maskText } from "@/lib/tether/mask";
import { norm } from "@/lib/text/norm";
import { TRUST_LABEL } from "@/lib/trust";
import type { Claim, Coverage, Importance, PlanItem, Responsibility, ReviewTier, RoleKey, Scores, Snapshot, Trust } from "@/lib/types";
import { shortDelta, trustSentence, type ClaimChange, type GapRef, type ScoreLines } from "./core/changes";
import {
  FINDING_ERRORS, FINDING_SOURCE_ID, FINDING_SOURCE_NAME, decodeAttachment, findingToDrafts, oneLine, parseFindingText,
  validateFinding, type FindingInput,
} from "./core/finding";
import { diffSnapshots, type SnapshotDiff } from "./core/snapshot";
import { parsePayload } from "./handover";
import { approveSnapshot, getReleaseInfo, reviewClaim, type ActionResult } from "./index";

export { FINDING_ERRORS } from "./core/finding";

export type FindingStatus = "pending" | "approved" | "rejected" | "withdrawn";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));
const gapKey = (responsibilityId: string, checkKey: string) => `${responsibilityId}|${checkKey}`;
const json = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

function importanceOf(weight: number): Importance {
  return weight === 5 ? "blocking" : weight === 3 ? "important" : "normal";
}

/** "13 Nov 2026, 14:05 IST": the same reading of time every page uses. */
function when(isoTime: string): string {
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return isoTime;
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";
}

// ---------------------------------------------------------------------------------------------
// The example finding of a demo (setting data, never core): <demo.dataDir>/ground_truth.json
// ---------------------------------------------------------------------------------------------

export interface ExampleFinding {
  /** Responsibility key or entity key the example belongs to, and its check. */
  responsibility: string | null;
  entity: string | null;
  checkKey: string;
  answer: string;
  note: string;
  /** Fixed time for the example, so its claim id repeats in every demo workspace (cache replay). */
  ts: string | null;
}

const exampleCache = new Map<string, ExampleFinding | null>();

/** The demo's example finding from its answer key ("finding", or "firstWeeks.example"); null when there is none. */
export function exampleFinding(pack: Pick<ResolvedPack, "id" | "demo">): ExampleFinding | null {
  const hit = exampleCache.get(pack.id);
  if (hit !== undefined) return hit;
  let out: ExampleFinding | null = null;
  try {
    if (!pack.demo) throw new Error("no demo");
    const file = path.join(process.cwd(), pack.demo.dataDir, "ground_truth.json");
    const gt = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const raw = (gt.finding ?? (gt.firstWeeks as Record<string, unknown> | undefined)?.example) as Record<string, unknown> | undefined;
    const answer = String(raw?.date ?? raw?.answer ?? "").trim();
    const checkKey = String(raw?.checkKey ?? "").trim();
    if (raw && answer && checkKey) {
      const today = new Date(pack.demo.today);
      const ts = typeof raw.ts === "string" && !Number.isNaN(Date.parse(raw.ts))
        ? new Date(raw.ts).toISOString()
        // One day after the demo's "today": the date it names is still ahead, as a real finding's would be.
        : Number.isNaN(today.getTime()) ? null : new Date(today.getTime() + 86_400_000).toISOString();
      out = {
        responsibility: typeof raw.responsibility === "string" ? raw.responsibility : null,
        entity: typeof raw.entity === "string" ? raw.entity : null,
        checkKey,
        answer,
        note: String(raw.note ?? "").trim(),
        ts,
      };
    }
  } catch {
    out = null;
  }
  exampleCache.set(pack.id, out);
  return out;
}

function exampleMatches(ex: ExampleFinding | null, resp: Pick<Responsibility, "key" | "entities">, checkKey: string): boolean {
  if (!ex || ex.checkKey !== checkKey) return false;
  if (ex.entity) return resp.entities.includes(ex.entity);
  return ex.responsibility === resp.key;
}

// ---------------------------------------------------------------------------------------------
// First weeks: the open gaps as a checklist
// ---------------------------------------------------------------------------------------------

export type GapRowState = "open" | "waiting" | "closed" | "rejected";

export interface OpenGapRow {
  responsibilityId: string;
  responsibilityKey: string;
  responsibilityTitle: string;
  checkKey: string;
  checkLabel: string;
  blocking: boolean;
  /** The check asks for an upcoming date: the form shows a date field. */
  needsDate: boolean;
  /** Coverage in the successor's latest test. */
  coverage: Coverage;
  /** Owner, due date and risk note from the continuation plan. */
  plan: PlanItem | null;
  state: GapRowState;
  /** Version that closed the gap (state "closed"). */
  closedInVersion: number | null;
  /** The successor cannot see the evidence that exists: ask the approver. */
  restricted: boolean;
  /** The viewing role may record a finding on this row right now. */
  canRecord: boolean;
  /** The reason the approver gave when the last finding on this gap was rejected. */
  rejectedReason: string | null;
  /** Demo helper: the example finding for this gap, when the demo's answer key has one. */
  example: { answer: string; note: string } | null;
}

export interface FirstWeeks {
  hasSnapshot: boolean;
  latestVersion: number | null;
  viewer: "successor" | "approver" | "leaving" | "other";
  blocking: OpenGapRow[];
  /** Non-blocking gaps from the successor's test. Empty for roles that may not see them. */
  other: OpenGapRow[];
  /** Gaps a finding closed since the first version (only findings the role may see). */
  closed: OpenGapRow[];
  counts: { open: number; waiting: number; closed: number };
  /** Roles the successor may keep or remove on a finding, in pack order. */
  roleChoices: { key: RoleKey; label: string; locked: boolean }[];
}

interface FindingRow {
  id: string;
  responsibilityId: string;
  checkKey: string;
  segmentId: string;
  attachmentSegmentId: string | null;
  claimId: string;
  recordedBy: RoleKey;
  status: FindingStatus;
  roleSet: RoleKey[];
  snapshotId: string | null;
  scoreDelta: string | null;
  reviewNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

function toFindingRow(r: Record<string, unknown>): FindingRow {
  return {
    id: String(r.id),
    responsibilityId: String(r.responsibility_id),
    checkKey: String(r.check_key),
    segmentId: String(r.segment_id),
    attachmentSegmentId: (r.attachment_segment_id as string | null) ?? null,
    claimId: String(r.claim_id),
    recordedBy: String(r.recorded_by),
    status: r.status as FindingStatus,
    roleSet: (r.role_set as RoleKey[]) ?? [],
    snapshotId: (r.snapshot_id as string | null) ?? null,
    scoreDelta: (r.score_delta as string | null) ?? null,
    reviewNote: (r.review_note as string | null) ?? null,
    createdAt: iso(r.created_at),
    decidedAt: r.decided_at ? iso(r.decided_at) : null,
  };
}

/** Finding rows the role may see (RLS: its role key is in the finding's role set). Newest first. */
async function visibleFindingRows(ws: string, role: RoleKey): Promise<FindingRow[]> {
  const rows = await withRole(ws, role, (tx) =>
    tx`SELECT * FROM findings WHERE workspace_id = ${ws} ORDER BY created_at DESC, id`);
  return rows.map(toFindingRow);
}

async function snapshotVersions(ws: string): Promise<Map<string, number>> {
  const rows = await db()`SELECT id, version FROM snapshots WHERE workspace_id = ${ws}`;
  return new Map(rows.map((r) => [String(r.id), Number(r.version)]));
}

function viewerKind(role: RoleKey, pack: ResolvedPack): FirstWeeks["viewer"] {
  if (role === pack.successorRole) return "successor";
  if (role === pack.approverRole) return "approver";
  if (role === pack.leaverRole) return "leaving";
  return "other";
}

/**
 * The First weeks page for one role. Blocking gaps and their plan are shown to every role (they are
 * in every handover already). The other open gaps come from the successor's own test and are shown
 * to the successor and the approver only. Finding state on a row comes from rows the role may read.
 */
export async function firstWeeks(ws: string, role: RoleKey): Promise<FirstWeeks> {
  const pack = await getWorkspacePack(ws);
  const lpack = toLacunaPack(pack);
  const successor = pack.successorRole as RoleKey;
  const viewer = viewerKind(role, pack);
  const versions = await snapshotVersions(ws);
  const latestVersion = versions.size ? Math.max(...versions.values()) : null;
  const base = pack.uploadDefaults.roleSet as RoleKey[];
  const keep = new Set<RoleKey>([successor, pack.approverRole as RoleKey]);
  const roleChoices = base.map((key) => ({ key, label: roleLabel(key, pack), locked: keep.has(key) }));
  const empty: FirstWeeks = {
    hasSnapshot: latestVersion !== null, latestVersion, viewer, blocking: [], other: [], closed: [],
    counts: { open: 0, waiting: 0, closed: 0 }, roleChoices,
  };
  if (latestVersion === null) return empty;

  const [run, resps, plans, findings, workspace] = await Promise.all([
    getLatestTestRun(ws, successor),
    listResponsibilities(ws),
    listPlanItems(ws),
    visibleFindingRows(ws, role),
    getWorkspace(ws),
  ]);
  if (!run) return empty;
  const byId = new Map(resps.map((r) => [r.id, r]));
  const checks = checksByResp(resps, lpack);
  const planOf = new Map(plans.map((p) => [gapKey(p.responsibilityId, p.checkKey), p]));
  const example = workspace?.kind === "demo" ? exampleFinding(pack) : null;
  // Newest finding per gap among those this role may see.
  const latestFinding = new Map<string, FindingRow>();
  for (const f of findings) {
    if (f.status === "withdrawn") continue;
    const k = gapKey(f.responsibilityId, f.checkKey);
    if (!latestFinding.has(k)) latestFinding.set(k, f);
  }

  const row = (resp: Responsibility, check: LacunaCheck, coverage: Coverage): OpenGapRow => {
    const k = gapKey(resp.id, check.key);
    const f = latestFinding.get(k) ?? null;
    const open = coverage !== "covered";
    const state: GapRowState = !open ? "closed" : f?.status === "pending" ? "waiting" : f?.status === "rejected" ? "rejected" : "open";
    const restricted = coverage === "restricted";
    const plan = planOf.get(k) ?? null;
    return {
      responsibilityId: resp.id, responsibilityKey: resp.key, responsibilityTitle: resp.title,
      checkKey: check.key, checkLabel: check.label, blocking: check.weight === 5, needsDate: check.needsDate === true,
      coverage, plan: plan ? { ...plan, dueDate: plan.dueDate ? String(plan.dueDate).slice(0, 10) : "" } : null,
      state,
      closedInVersion: !open && f?.snapshotId ? versions.get(f.snapshotId) ?? null : null,
      restricted,
      canRecord: viewer === "successor" && open && !restricted && state !== "waiting",
      rejectedReason: state === "rejected" ? f?.reviewNote ?? null : null,
      example: exampleMatches(example, resp, check.key) ? { answer: example!.answer, note: example!.note } : null,
    };
  };

  const blocking: OpenGapRow[] = [];
  const other: OpenGapRow[] = [];
  const closed: OpenGapRow[] = [];
  const seeOther = viewer === "successor" || viewer === "approver";
  for (const r of run.results) {
    const resp = byId.get(r.responsibilityId);
    const check = resp ? findCheck(checks, r.responsibilityId, r.checkKey) : undefined;
    if (!resp || !check) continue;
    if (r.coverage === "covered") {
      const f = latestFinding.get(gapKey(resp.id, check.key));
      if (f?.status === "approved" && f.snapshotId) closed.push(row(resp, check, r.coverage));
      continue;
    }
    if (check.weight === 5) blocking.push(row(resp, check, r.coverage));
    else if (seeOther) other.push(row(resp, check, r.coverage));
  }
  const order = (a: OpenGapRow, b: OpenGapRow) =>
    a.responsibilityKey.localeCompare(b.responsibilityKey) || a.checkLabel.localeCompare(b.checkLabel);
  blocking.sort(order);
  other.sort(order);
  closed.sort(order);
  const open = [...blocking, ...other];
  return {
    hasSnapshot: true, latestVersion, viewer, blocking, other, closed,
    counts: { open: open.length, waiting: open.filter((g) => g.state === "waiting").length, closed: closed.length },
    roleChoices,
  };
}

/** The checklist rows of First weeks for one role: blocking gaps first, then the others. */
export async function listOpenGaps(ws: string, role: RoleKey): Promise<OpenGapRow[]> {
  const fw = await firstWeeks(ws, role);
  return [...fw.blocking, ...fw.other];
}

// ---------------------------------------------------------------------------------------------
// Findings as a role sees them
// ---------------------------------------------------------------------------------------------

export interface RelatedClaim {
  claimId: string;
  statement: string;
  trustLabel: string;
}

export interface FindingView {
  id: string;
  status: FindingStatus;
  responsibilityId: string;
  checkKey: string;
  /** "{responsibility title}: {check label}" */
  gap: string;
  answer: string;
  note: string;
  /** Stored as text, never fetched, never rendered as a link. */
  link: string | null;
  fileName: string | null;
  fileBytes: number | null;
  /** The evidence text and the attached file text, as stored (masked). */
  evidenceText: string;
  fileText: string | null;
  segmentId: string;
  claimId: string;
  statement: string;
  trust: Trust;
  tier: ReviewTier;
  conflicting: boolean;
  roleSet: RoleKey[];
  /** Role labels, only when the finding is narrower than the pack default. */
  narrowedTo: string[] | null;
  recordedAt: string;
  decidedAt: string | null;
  reviewNote: string | null;
  /** Version of the snapshot that carries it; null while waiting (also when the release rule blocks). */
  version: number | null;
  scoreDelta: string | null;
  agrees: RelatedClaim[];
  disagrees: RelatedClaim[];
}

/**
 * Findings the role may see, newest first. Everything with content (answer, note, link, file,
 * statement, the approver's reason) is read inside withRole, so a role outside a finding's role
 * set gets no row at all.
 */
export async function listFindings(ws: string, role: RoleKey): Promise<FindingView[]> {
  const pack = await getWorkspacePack(ws);
  const lpack = toLacunaPack(pack);
  const rows = await visibleFindingRows(ws, role);
  if (!rows.length) return [];
  const segIds = rows.flatMap((f) => [f.segmentId, ...(f.attachmentSegmentId ? [f.attachmentSegmentId] : [])]);
  const { segs, claims } = await withRole(ws, role, async (tx) => {
    const s = await tx`
      SELECT DISTINCT ON (id) id, text, meta FROM segments
      WHERE workspace_id = ${ws} AND id = ANY(${segIds}::text[]) ORDER BY id, version DESC`;
    const c = await tx`SELECT * FROM claims WHERE workspace_id = ${ws} AND state <> 'dropped'`;
    return { segs: [...s], claims: c.map(toClaim) };
  });
  const segById = new Map(segs.map((s) => [String(s.id), s]));
  const claimById = new Map(claims.map((c) => [c.id, c]));
  const [resps, versions] = await Promise.all([listResponsibilities(ws), snapshotVersions(ws)]);
  const respById = new Map(resps.map((r) => [r.id, r]));
  const checks = checksByResp(resps, lpack);
  const base = pack.uploadDefaults.roleSet as RoleKey[];

  const out: FindingView[] = [];
  for (const f of rows) {
    const seg = segById.get(f.segmentId);
    if (!seg) continue; // the evidence is not visible to this role: no row
    const meta = json<Record<string, unknown>>(seg.meta, {});
    const parts = parseFindingText(String(seg.text), { hasLink: meta.hasLink === true, hasFile: Boolean(meta.attachmentName) });
    const file = f.attachmentSegmentId ? segById.get(f.attachmentSegmentId) : undefined;
    const fileMeta = file ? json<Record<string, unknown>>(file.meta, {}).attachment as { bytes?: number } | undefined : undefined;
    const claim = claimById.get(f.claimId);
    const resp = respById.get(f.responsibilityId);
    const check = findCheck(checks, f.responsibilityId, f.checkKey);
    const related = (claim ? claims : []).filter((c) =>
      c.id !== f.claimId && c.entity === claim!.entity && c.attribute === claim!.attribute
      && (c.state === "active" || c.state === "conflicting") && c.review !== "rejected"
      && !(c.origin === "successor_finding" && c.review === "pending"));
    const view = (c: Claim): RelatedClaim => ({ claimId: c.id, statement: c.statement, trustLabel: TRUST_LABEL[c.trust] });
    out.push({
      id: f.id,
      status: f.status,
      responsibilityId: f.responsibilityId,
      checkKey: f.checkKey,
      gap: `${resp?.title ?? f.responsibilityId}: ${check?.label ?? f.checkKey}`,
      answer: parts.answer,
      note: parts.note,
      link: parts.link,
      fileName: parts.fileName,
      fileBytes: typeof fileMeta?.bytes === "number" ? fileMeta.bytes : null,
      evidenceText: String(seg.text),
      fileText: file ? String(file.text) : null,
      segmentId: f.segmentId,
      claimId: f.claimId,
      statement: claim?.statement ?? parts.answer,
      trust: claim?.trust ?? "successor_found",
      tier: claim ? (claim.tier === "C" || tierFor(claim, pack) === "C" ? "C" : claim.tier) : "B",
      conflicting: claim?.state === "conflicting",
      roleSet: f.roleSet,
      narrowedTo: f.roleSet.length < base.length ? f.roleSet.map((r) => roleLabel(r, pack)) : null,
      recordedAt: f.createdAt,
      decidedAt: f.decidedAt,
      reviewNote: f.reviewNote,
      version: f.snapshotId ? versions.get(f.snapshotId) ?? null : null,
      scoreDelta: f.scoreDelta,
      agrees: claim ? related.filter((c) => norm(c.value) === norm(claim.value)).map(view) : [],
      disagrees: claim ? related.filter((c) => norm(c.value) !== norm(claim.value) && comparable(c, claim)).map(view) : [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Record and withdraw (the successor)
// ---------------------------------------------------------------------------------------------

export interface FindingForm {
  responsibilityId: string;
  checkKey: string;
  answer: string;
  note: string;
  link?: string | null;
  /** The uploaded file as bytes; decoded and checked here. */
  attachment?: { name: string; bytes: Uint8Array } | null;
  /** Roles ticked on the form. Fewer than the pack default narrows; roles outside it are ignored. */
  narrowRoles?: RoleKey[] | null;
  /** "Use the example finding" was pressed (demo workspaces): a fixed time keeps the claim id stable. */
  example?: boolean;
}

export type RecordResult = { ok: true; findingId: string; claimId: string; roleSet: RoleKey[] } | { ok: false; error: string };

const SEP = "\n␞\n";

/**
 * Mask the four texts of a finding in one pass (secrets become [SECRET:type], emails and phones
 * become contact tokens), then give the contact tokens workspace-unique numbers.
 */
async function maskFinding(ws: string, parts: { answer: string; note: string; link: string; file: string | null }) {
  const joined = [parts.answer, parts.note, parts.link, parts.file ?? ""].join(SEP);
  const masked = maskText(joined, { contactsKey: process.env.CONTACTS_KEY ?? "", people: null });
  let text = masked.text;
  const contacts: { token: string; kind: "email" | "phone"; valueEnc: string }[] = [];
  if (masked.contacts.length) {
    const [{ n }] = await db()`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = ${ws}`;
    const renum = new Map<string, string>();
    for (const c of masked.contacts) {
      if (!renum.has(c.token)) renum.set(c.token, `[CONTACT:c-${9000 + Number(n) + renum.size + 1}]`);
      contacts.push({ token: renum.get(c.token)!, kind: c.kind, valueEnc: c.valueEnc });
    }
    for (const [from, to] of renum) text = text.split(from).join(to);
  }
  const [answer = "", note = "", link = "", file = ""] = text.split(SEP);
  return { answer, note, link, file: parts.file === null ? null : file, secrets: masked.secrets, contacts };
}

/**
 * The successor records a finding on an open gap. It is stored as evidence labelled
 * "Successor found" and waits for the approver: no test run, no snapshot, no score moves.
 */
export async function recordFinding(ws: string, actor: RoleKey, form: FindingForm): Promise<RecordResult> {
  const sql = db();
  const pack = await getWorkspacePack(ws);
  const lpack = toLacunaPack(pack);
  const successor = pack.successorRole as RoleKey;
  const approverLabel = roleLabel(pack.approverRole, pack);
  const fail = (error: string): RecordResult => ({ ok: false, error });
  if (actor !== successor) return fail(`Only ${roleLabel(successor, pack)} can record findings.`);

  const [snap] = await sql`SELECT 1 FROM snapshots WHERE workspace_id = ${ws} LIMIT 1`;
  if (!snap) return fail(FINDING_ERRORS.noSnapshot);
  const resps = await listResponsibilities(ws);
  const resp = resps.find((r) => r.id === form.responsibilityId);
  const check = resp ? findCheck(checksByResp(resps, lpack), resp.id, form.checkKey) : undefined;
  if (!resp || !check) return fail("Gap not found.");
  const run = await getLatestTestRun(ws, successor);
  const result = run?.results.find((r) => r.responsibilityId === resp.id && r.checkKey === check.key);
  if (!result || result.coverage === "covered") return fail(FINDING_ERRORS.gapClosed);
  if (result.coverage === "restricted") return fail(`This gap is restricted for your role. Ask the approver (${approverLabel}).`);

  let attachment: { name: string; text: string; bytes: number } | null = null;
  if (form.attachment && form.attachment.bytes.byteLength > 0) {
    const decoded = decodeAttachment(form.attachment.name, form.attachment.bytes);
    if (!decoded.ok) return fail(decoded.error);
    attachment = decoded.attachment;
  }

  const workspace = await getWorkspace(ws);
  const today = await workspaceNow(ws);
  const base = pack.uploadDefaults.roleSet as RoleKey[];
  const picked = (form.narrowRoles ?? []).filter((r) => base.includes(r));
  const input: FindingInput = {
    answer: form.answer ?? "", note: form.note ?? "", link: (form.link ?? "").trim() || null, attachment,
    resp: { id: resp.id, key: resp.key, title: resp.title, entities: resp.entities },
    check: { key: check.key, label: check.label, attributes: check.attributes, needsDate: check.needsDate },
    baseRoleSet: base,
    keepRoles: [successor, pack.approverRole as RoleKey],
    // Every box ticked (or none sent) means "no narrowing".
    narrowTo: form.narrowRoles && picked.length < base.length ? picked : null,
    successorLabel: roleLabel(successor, pack),
    entityLabel: entityLabel(resp.entities[0] ?? "", pack) || resp.title,
    ts: new Date().toISOString(),
    today,
    recordedByRole: actor,
  };
  const valid = validateFinding(input);
  if (!valid.ok) return fail(valid.error);

  // Mask before anything is stored. (Improvement 2's sensitivity classifier, once merged, narrows
  // the role set here: intersect input.narrowTo with its result. It can never widen.)
  const masked = await maskFinding(ws, {
    answer: oneLine(input.answer), note: input.note.trim(), link: input.link ?? "", file: attachment?.text ?? null,
  });
  input.answer = masked.answer;
  input.note = masked.note;
  input.link = masked.link || null;
  if (attachment) input.attachment = { ...attachment, text: masked.file ?? "" };

  // The demo's example finding gets a fixed time, so its claim id is the same in every demo
  // workspace and the re-test can replay from the model cache. Typed findings use the real time.
  const example = workspace?.kind === "demo" ? exampleFinding(pack) : null;
  if (form.example && example?.ts && exampleMatches(example, resp, check.key)
    && oneLine(form.answer) === example.answer && form.note.trim() === example.note) {
    const fixed = findingToDrafts({ ...input, ts: example.ts });
    const [used] = await sql`SELECT 1 FROM findings WHERE workspace_id = ${ws} AND id = ${fixed.findingId}`;
    if (!used) input.ts = example.ts;
  }

  const drafts = findingToDrafts(input);
  const { segment, attachment: fileSegment, roleSet } = drafts;
  const draft = drafts.claim;
  // Citation rule, checked like any claim: the quote is an exact substring of the cited segment.
  const quote = draft.citations[0].quote ?? "";
  if (!norm(segment.text).includes(norm(quote))) return fail("The answer could not be quoted exactly. Change it and try again.");

  // One finding waiting per gap. The same content sent twice (a double click, a refresh) is one finding.
  const [waiting] = await sql`
    SELECT f.id, f.claim_id, f.role_set, s.text_hash FROM findings f
    JOIN segments s ON s.workspace_id = f.workspace_id AND s.id = f.segment_id
    WHERE f.workspace_id = ${ws} AND f.responsibility_id = ${resp.id} AND f.check_key = ${check.key} AND f.status = 'pending'
    LIMIT 1`;
  if (waiting) {
    if (String(waiting.text_hash) === segment.textHash) {
      return { ok: true, findingId: String(waiting.id), claimId: String(waiting.claim_id), roleSet: waiting.role_set as RoleKey[] };
    }
    return fail(FINDING_ERRORS.duplicate);
  }

  const id = makeClaimId(draft.entity, draft.attribute, draft.value, [segment.id]);
  const importance = importanceOf(check.weight);
  const claim: Claim = {
    id, workspaceId: ws, entity: draft.entity, entityLabel: draft.entityLabel, attribute: draft.attribute,
    value: draft.value, statement: draft.statement, citations: draft.citations, trust: "successor_found",
    state: "active", stateNote: null, supersededBy: null, roleSet, validFrom: input.ts, authorId: null,
    sourceKinds: ["finding"], importance, tier: "B", review: "pending", reviewNote: null,
    origin: "successor_finding", supportCheck: null,
  };
  claim.tier = tierFor(claim, pack);
  const segs = fileSegment ? [segment, fileSegment] : [segment];

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO sources (workspace_id, id, kind, name, role_set, origin)
        VALUES (${ws}, ${FINDING_SOURCE_ID}, 'finding', ${FINDING_SOURCE_NAME}, ${base}::text[], 'finding')
        ON CONFLICT (workspace_id, id) DO NOTHING`;
      let added = 0;
      for (const s of segs) {
        const rows = await tx`
          INSERT INTO segments (workspace_id, id, version, source_id, source_kind, kind, ts, author_id, thread, position, text, text_hash, role_set, meta)
          VALUES (${ws}, ${s.id}, 1, ${FINDING_SOURCE_ID}, 'finding', 'finding', ${s.ts}, ${null}, ${s.thread}, ${s.position},
            ${s.text}, ${s.textHash}, ${roleSet}::text[], ${JSON.stringify(s.meta)}::jsonb)
          ON CONFLICT DO NOTHING RETURNING id`;
        added += rows.length;
      }
      await tx`UPDATE sources SET segment_count = segment_count + ${added}, masked_secrets = masked_secrets + ${masked.secrets},
        masked_contacts = masked_contacts + ${masked.contacts.length} WHERE workspace_id = ${ws} AND id = ${FINDING_SOURCE_ID}`;
      const contactRoles = (pack.contactsRoles as RoleKey[]).filter((r) => roleSet.includes(r));
      for (const c of masked.contacts) {
        await tx`
          INSERT INTO contacts (workspace_id, token, kind, person_id, value_enc, role_set, source_id)
          VALUES (${ws}, ${c.token}, ${c.kind}, ${null}, ${c.valueEnc}, ${contactRoles}::text[], ${FINDING_SOURCE_ID})
          ON CONFLICT DO NOTHING`;
      }
      await tx`
        INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, state,
          role_set, valid_from, author_id, source_kinds, importance, tier, review, origin, source_ids)
        VALUES (${ws}, ${claim.id}, ${claim.entity}, ${claim.entityLabel}, ${claim.attribute}, ${claim.value}, ${claim.statement},
          ${JSON.stringify(claim.citations)}::jsonb, 'successor_found', 'active', ${roleSet}::text[], ${input.ts}, ${null},
          ${["finding"]}::text[], ${claim.importance}, ${claim.tier}, 'pending', 'successor_finding', ${[FINDING_SOURCE_ID]}::text[])
        ON CONFLICT (workspace_id, id) DO NOTHING`;
      await tx`INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
        VALUES (${ws}, ${claim.id}, 'created', ${JSON.stringify({
          origin: "successor_finding", findingId: drafts.findingId, segmentId: segment.id, trust: "successor_found", roleSet,
          narrowed: roleSet.length < base.length, hasLink: Boolean(input.link), hasFile: Boolean(fileSegment),
        })}::jsonb, ${actor})`;
      await tx`
        INSERT INTO findings (workspace_id, id, responsibility_id, check_key, segment_id, attachment_segment_id, claim_id,
          recorded_by, status, role_set)
        VALUES (${ws}, ${drafts.findingId}, ${resp.id}, ${check.key}, ${segment.id}, ${fileSegment?.id ?? null}, ${claim.id},
          ${actor}, 'pending', ${roleSet}::text[])`;
    });
  } catch (err) {
    // Two tabs saved for the same gap at once: the unique index lets one through.
    if ((err as { code?: string }).code === "23505") return fail(FINDING_ERRORS.duplicate);
    throw err;
  }
  await audit(ws, actor, "record_finding", {
    findingId: drafts.findingId, claimId: claim.id, responsibilityId: resp.id, checkKey: check.key, roleSet,
    maskedSecrets: masked.secrets, maskedContacts: masked.contacts.length,
  });
  return { ok: true, findingId: drafts.findingId, claimId: claim.id, roleSet };
}

/** The successor takes back a finding that is still waiting. Its claim is dropped, never deleted. */
export async function withdrawFinding(ws: string, actor: RoleKey, findingId: string): Promise<ActionResult> {
  const sql = db();
  const pack = await getWorkspacePack(ws);
  if (actor !== pack.successorRole) return { ok: false, error: `Only ${roleLabel(pack.successorRole, pack)} can withdraw a finding.` };
  const [row] = await sql`SELECT * FROM findings WHERE workspace_id = ${ws} AND id = ${findingId}`;
  if (!row) return { ok: false, error: "Finding not found." };
  const f = toFindingRow(row);
  if (f.status === "withdrawn") return { ok: true };
  if (f.status !== "pending") return { ok: false, error: "This finding has already been reviewed." };
  const note = "Withdrawn by the successor before review";
  const done = await sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE findings SET status = 'withdrawn', decided_at = now()
      WHERE workspace_id = ${ws} AND id = ${findingId} AND status = 'pending' RETURNING id`;
    if (!rows.length) return false;
    await tx`UPDATE claims SET state = 'dropped', state_note = ${note}, updated_at = now()
      WHERE workspace_id = ${ws} AND id = ${f.claimId} AND review = 'pending'`;
    await tx`INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
      VALUES (${ws}, ${f.claimId}, 'dropped', ${JSON.stringify({ note, findingId })}::jsonb, ${actor})`;
    return true;
  });
  if (done) await audit(ws, actor, "withdraw_finding", { findingId, claimId: f.claimId });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Decide (the approver)
// ---------------------------------------------------------------------------------------------

export type DecideResult = ActionResult & {
  /** The snapshot that carries the finding. */
  snapshot?: Snapshot;
  /** "B 5 → 4." */
  delta?: string;
  /** The first release blocker: the finding is approved and the snapshot waits. */
  blocked?: string;
  /** The version the waiting snapshot will get. */
  nextVersion?: number;
};

/**
 * Re-test options after a finding: only the responsibilities the finding can change are judged
 * again (RunTestOptions.only); the results of every other one are copied from the latest run, so
 * approving a finding costs one model call per tested role instead of one per responsibility.
 * Affected = the finding's own responsibility and any other that shares an entity with it (the
 * rules that re-run on approval work per entity, so a superseded or conflicting record can only
 * sit under those). An unknown responsibility id falls back to the full test.
 */
export function retestOptions(
  findingId: string, responsibilityId: string, resps: Pick<Responsibility, "id" | "entities">[],
): RunTestOptions {
  const trigger = `finding ${findingId}`;
  const own = resps.find((r) => r.id === responsibilityId);
  if (!own) return { trigger };
  const entities = new Set(own.entities);
  const only = resps.filter((r) => r.id === own.id || r.entities.some((e) => entities.has(e))).map((r) => r.id);
  return { trigger, only };
}

async function loadFinding(ws: string, findingId: string): Promise<FindingRow | null> {
  const [row] = await db()`SELECT * FROM findings WHERE workspace_id = ${ws} AND id = ${findingId}`;
  return row ? toFindingRow(row) : null;
}

async function carriedResult(ws: string, snapshotId: string): Promise<DecideResult> {
  const sql = db();
  const [row] = await sql`SELECT * FROM snapshots WHERE workspace_id = ${ws} AND id = ${snapshotId}`;
  if (!row) return { ok: true };
  const [ch] = await sql`SELECT diff FROM snapshot_changes WHERE workspace_id = ${ws} AND snapshot_id = ${snapshotId}`;
  const diff = ch ? json<SnapshotDiff | null>(ch.diff, null) : null;
  const snapshot = toSnapshot(row);
  return { ok: true, snapshot, delta: diff ? shortDelta(diff.scores.before, diff.scores.after) : undefined };
}

/** After approval: rules, re-test, then the next snapshot, or the blocker when the release rule says no. */
async function releaseAfterApproval(ws: string, actor: RoleKey, pack: ResolvedPack, findingId: string): Promise<DecideResult> {
  const sql = db();
  let f = await loadFinding(ws, findingId);
  if (!f) return { ok: false, error: "Finding not found." };
  if (f.snapshotId) return carriedResult(ws, f.snapshotId);
  // A snapshot approved in the meantime may already carry it.
  const [latest] = await sql`SELECT id, version, claim_ids FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC LIMIT 1`;
  if (latest && (latest.claim_ids as string[]).includes(f.claimId) && await snapshotCarries(ws, String(latest.id), f)) {
    return carriedResult(ws, String(latest.id));
  }

  await rerunRules(ws, actor);
  const opts = retestOptions(f.id, f.responsibilityId, await listResponsibilities(ws));
  await Promise.all(pack.testRoles.map((role) => runTest(ws, role, opts)));
  const release = await getReleaseInfo(ws);
  const nextVersion = Number(latest?.version ?? 0) + 1;
  if (release.blockers.length > 0) {
    await audit(ws, actor, "decide_finding", { findingId, decision: "approved", snapshot: null, blocked: release.blockers[0] });
    return { ok: true, blocked: release.blockers[0], nextVersion };
  }
  f = await loadFinding(ws, findingId);
  if (f?.snapshotId) return carriedResult(ws, f.snapshotId);

  const snap = await approveSnapshot(ws, actor);
  if (!snap.ok) {
    const again = await loadFinding(ws, findingId);
    if (again?.snapshotId) return carriedResult(ws, again.snapshotId);
    if (snap.code === "release_blocked") return { ok: true, blocked: snap.error, nextVersion };
    return { ok: false, code: snap.code, error: snap.error };
  }
  // A finding that a record superseded is not in the payload; it is still tied to this version.
  await sql`UPDATE findings SET snapshot_id = ${snap.snapshot!.id}
    WHERE workspace_id = ${ws} AND id = ${findingId} AND snapshot_id IS NULL`;
  await audit(ws, actor, "decide_finding", { findingId, decision: "approved", snapshot: snap.snapshot!.id, version: snap.snapshot!.version });
  return carriedResult(ws, snap.snapshot!.id);
}

/** Tie an approved finding to the snapshot that already carries its claim. False when another call did it first. */
async function snapshotCarries(ws: string, snapshotId: string, f: FindingRow): Promise<boolean> {
  const sql = db();
  const [ch] = await sql`SELECT delta_text FROM snapshot_changes WHERE workspace_id = ${ws} AND snapshot_id = ${snapshotId}`;
  const rows = await sql`
    UPDATE findings SET snapshot_id = ${snapshotId}, score_delta = ${ch ? String(ch.delta_text) : null}
    WHERE workspace_id = ${ws} AND id = ${f.id} AND snapshot_id IS NULL AND status = 'approved' RETURNING id`;
  return rows.length > 0;
}

const REVIEW_ERRORS: Record<string, string> = {
  evidence_not_opened: "Open the evidence and tick the box before deciding.",
  reason_required: "Write a reason of at least 10 characters.",
};

const inFlight = new Map<string, Promise<DecideResult>>();

/**
 * The approver decides a finding.
 * Approved: the claim is approved under the usual tier rules, the rules re-run, the successor
 * is re-tested, and the next snapshot is created with its stored diff. When the release rule
 * blocks that snapshot, the finding stays approved and the result names the blocker.
 * Rejected: the claim is rejected, the gap stays open; no test run and no snapshot.
 * Safe to repeat: a second call for the same decision returns what the first one did.
 */
export function decideFinding(
  ws: string, actor: RoleKey, findingId: string, decision: "approved" | "rejected",
  opts: { note: string; evidenceOpened: boolean },
): Promise<DecideResult> {
  const key = `${ws}|${findingId}`;
  const running = inFlight.get(key);
  const next = (running ?? Promise.resolve()).catch(() => undefined).then(() => decide(ws, actor, findingId, decision, opts));
  inFlight.set(key, next);
  void next.finally(() => {
    if (inFlight.get(key) === next) inFlight.delete(key);
  }).catch(() => undefined);
  return next;
}

async function decide(
  ws: string, actor: RoleKey, findingId: string, decision: "approved" | "rejected",
  opts: { note: string; evidenceOpened: boolean },
): Promise<DecideResult> {
  const sql = db();
  const pack = await getWorkspacePack(ws);
  const roles = approvalRoles(pack);
  if (actor === roles.leaver) return { ok: false, code: "leaver_cannot_approve", error: "The leaver can never approve." };
  if (actor !== roles.approver) return { ok: false, code: "not_approver", error: `Only ${roles.approverLabel} can approve findings.` };
  const f = await loadFinding(ws, findingId);
  if (!f) return { ok: false, error: "Finding not found." };
  if (f.status === "withdrawn") return { ok: false, error: "This finding was withdrawn." };
  const note = (opts.note ?? "").trim();

  if (decision === "rejected") {
    if (f.status === "rejected") return { ok: true };
    if (f.status === "approved") return { ok: false, error: "This finding was already approved." };
    const res = await reviewClaim(ws, f.claimId, "rejected", actor, { note, evidenceOpened: opts.evidenceOpened });
    if (!res.ok) return { ok: false, code: res.code, error: REVIEW_ERRORS[res.code ?? ""] ?? res.error };
    await sql`UPDATE findings SET status = 'rejected', review_note = ${note || null}, decided_at = now()
      WHERE workspace_id = ${ws} AND id = ${findingId} AND status = 'pending'`;
    // A rejected claim leaves any conflict it was part of.
    await rerunRules(ws, actor);
    await audit(ws, actor, "decide_finding", { findingId, decision: "rejected" });
    return { ok: true };
  }

  if (f.status === "rejected") return { ok: false, error: "This finding was already rejected." };
  if (f.status === "pending") {
    const res = await reviewClaim(ws, f.claimId, "approved", actor, { note, evidenceOpened: opts.evidenceOpened });
    if (!res.ok) return { ok: false, code: res.code, error: REVIEW_ERRORS[res.code ?? ""] ?? res.error };
    await sql`UPDATE findings SET status = 'approved', review_note = ${note || null}, decided_at = now()
      WHERE workspace_id = ${ws} AND id = ${findingId} AND status = 'pending'`;
  }
  return releaseAfterApproval(ws, actor, pack, findingId);
}

// ---------------------------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------------------------

export interface ChangeLine {
  kind: "added" | "removed" | "trust" | "text";
  /** "Added: ...", "Removed: ...", "Changed: ... Trust went from X to Y." */
  text: string;
  claimId: string;
}

export interface ChangeView {
  snapshotId: string;
  version: number;
  fromVersion: number | null;
  approvedAt: string;
  cause: "first" | "finding" | "manual";
  /** "What changed in v2" */
  heading: string;
  /** "Compared with v1. Approved 13 Nov 2026, 14:05 IST." */
  sub: string;
  /** "Why: a successor finding was approved." */
  causeLine: string;
  /** Version history column: "First release", "Finding approved: {gap}", "Released by the approver". */
  why: string;
  claims: ChangeLine[];
  /** "Gap closed: ..." and "Gap opened: ..." */
  gaps: string[];
  /** "The continuation plan changed." or null. */
  plan: string | null;
  /** The B, C and K sentences, in that order. */
  scores: string[];
  /** Changes this role may not see, as a count only. */
  hidden: number;
  /** "N restricted changes. Ask the approver (...)." or null. */
  stub: string | null;
  /** "No claims changed in this version." when nothing changed for anyone. */
  empty: string | null;
  /** "This is a new version. Read back again to acknowledge v{n}." or null. */
  reack: string | null;
  /** "+1 added · −0 removed · ~0 changed" counts of the whole diff (numbers only). */
  counts: { added: number; removed: number; changed: number };
}

export function changeStub(n: number, approverLabel: string): string | null {
  if (n <= 0) return null;
  return n === 1
    ? `1 restricted change. Ask the approver (${approverLabel}).`
    : `${n} restricted changes. Ask the approver (${approverLabel}).`;
}

/**
 * The "What changed" panel of one snapshot for one role. Ids, numbers and sentences come from the
 * stored record; every statement is read from snapshot_claims inside withRole, so a claim outside
 * the role's permissions adds one to a count and nothing else. A gap line caused by a claim the
 * role may not see is counted the same way. Snapshots from before the record existed fall back to
 * the diff of the two stored payloads (claims and scores, no gap list).
 */
export async function whatChanged(ws: string, role: RoleKey, snapshotId: string): Promise<ChangeView | null> {
  const sql = db();
  const pack = await getWorkspacePack(ws);
  const approverLabel = roleLabel(pack.approverRole, pack);
  const [row] = await sql`SELECT * FROM snapshots WHERE workspace_id = ${ws} AND id = ${snapshotId}`;
  if (!row) return null;
  const version = Number(row.version);
  const [prevRow] = await sql`
    SELECT id, version, payload FROM snapshots WHERE workspace_id = ${ws} AND version < ${version} ORDER BY version DESC LIMIT 1`;
  const [stored] = await sql`SELECT * FROM snapshot_changes WHERE workspace_id = ${ws} AND snapshot_id = ${snapshotId}`;

  const payload = parsePayload(row.payload);
  const prevPayload = prevRow ? parsePayload(prevRow.payload) : null;
  const diff: SnapshotDiff | null = stored ? json<SnapshotDiff | null>(stored.diff, null) : payload ? diffSnapshots(prevPayload, payload) : null;
  if (!diff) return null;
  const gapsClosed = stored ? json<GapRef[]>(stored.gaps_closed, []) : [];
  const gapsOpened = stored ? json<GapRef[]>(stored.gaps_opened, []) : [];
  const claimChanges = stored ? json<ClaimChange[]>(stored.claim_changes, []) : diff.changed.map((id) => ({ claimId: id, kind: "text" as const }));
  const lines = stored ? json<ScoreLines | null>(stored.lines, null) : null;
  const causeRaw = stored ? json<{ type?: string; findingIds?: string[] }>(stored.cause, {}) : {};
  const cause: ChangeView["cause"] = !prevRow ? "first" : causeRaw.type === "finding" ? "finding" : "manual";

  // Statements, under this role's permissions.
  const snapIds = prevRow ? [snapshotId, String(prevRow.id)] : [snapshotId];
  const seen = await withRole(ws, role, async (tx) => {
    const claims = await tx`
      SELECT snapshot_id, claim_id, statement FROM snapshot_claims
      WHERE workspace_id = ${ws} AND snapshot_id = ANY(${snapIds}::text[])`;
    const findings = causeRaw.findingIds?.length
      ? await tx`SELECT responsibility_id, check_key FROM findings WHERE workspace_id = ${ws} AND id = ANY(${causeRaw.findingIds}::text[])`
      : [];
    return { claims: [...claims], findings: [...findings] };
  });
  const now = new Map<string, string>();
  const before = new Map<string, string>();
  for (const c of seen.claims) (String(c.snapshot_id) === snapshotId ? now : before).set(String(c.claim_id), String(c.statement));

  const claims: ChangeLine[] = [];
  const hiddenIds = new Set<string>();
  for (const id of diff.added) {
    if (now.has(id)) claims.push({ kind: "added", claimId: id, text: `Added: ${now.get(id)}` });
    else hiddenIds.add(id);
  }
  for (const id of diff.removed) {
    if (before.has(id)) claims.push({ kind: "removed", claimId: id, text: `Removed: ${before.get(id)}` });
    else hiddenIds.add(id);
  }
  const changeOf = new Map(claimChanges.map((c) => [c.claimId, c]));
  for (const id of diff.changed) {
    if (!now.has(id)) {
      hiddenIds.add(id);
      continue;
    }
    const ch = changeOf.get(id);
    if (ch?.kind === "trust" && ch.from && ch.to) {
      claims.push({ kind: "trust", claimId: id, text: `Changed: ${now.get(id)} ${trustSentence(ch.from, ch.to)}` });
    } else {
      claims.push({ kind: "text", claimId: id, text: `Changed: ${now.get(id)} (edited by reviewer)` });
    }
  }

  // Gap lines. One caused by a hidden claim change is hidden too.
  const resps = await listResponsibilities(ws);
  const respById = new Map(resps.map((r) => [r.id, r]));
  const checks = checksByResp(resps, toLacunaPack(pack));
  const gapName = (g: { responsibilityId: string; checkKey: string }) =>
    `${respById.get(g.responsibilityId)?.title ?? g.responsibilityId}: ${findCheck(checks, g.responsibilityId, g.checkKey)?.label ?? g.checkKey}`;
  const gaps: string[] = [];
  let hiddenGaps = 0;
  for (const [label, list] of [["Gap closed", gapsClosed], ["Gap opened", gapsOpened]] as const) {
    for (const g of list) {
      if ((g.claimIds ?? []).some((id) => hiddenIds.has(id))) hiddenGaps++;
      else gaps.push(`${label}: ${gapName(g)}`);
    }
  }

  const scores = lines
    ? [lines.b, lines.c, lines.k]
    : scoreLinesFromDiff(diff);
  const hidden = hiddenIds.size + hiddenGaps;
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  const findingGap = seen.findings[0]
    ? gapName({ responsibilityId: String(seen.findings[0].responsibility_id), checkKey: String(seen.findings[0].check_key) })
    : null;

  let reack: string | null = null;
  if (version > 1 && role !== pack.leaverRole) {
    const [{ v: latest }] = await sql`SELECT max(version)::int AS v FROM snapshots WHERE workspace_id = ${ws}`;
    if (Number(latest) === version) {
      const [ack] = await sql`
        SELECT 1 FROM acknowledgements WHERE workspace_id = ${ws} AND role = ${role} AND snapshot_id = ${snapshotId} LIMIT 1`;
      if (!ack) reack = `This is a new version. Read back again to acknowledge v${version}.`;
    }
  }

  return {
    snapshotId,
    version,
    fromVersion: prevRow ? Number(prevRow.version) : null,
    approvedAt: iso(row.approved_at),
    cause,
    heading: `What changed in v${version}`,
    sub: prevRow
      ? `Compared with v${Number(prevRow.version)}. Approved ${when(iso(row.approved_at))}.`
      : `First version. Approved ${when(iso(row.approved_at))}.`,
    causeLine: cause === "first" ? "Why: this is the first release."
      : cause === "finding" ? "Why: a successor finding was approved."
        : "Why: the approver released a new version.",
    why: cause === "first" ? "First release"
      : cause === "finding" ? (findingGap ? `Finding approved: ${findingGap}` : "Finding approved")
        : "Released by the approver",
    claims,
    gaps,
    plan: prevRow && diff.planChanged ? "The continuation plan changed." : null,
    scores,
    hidden,
    stub: changeStub(hidden, approverLabel),
    empty: prevRow && total === 0 && gapsClosed.length + gapsOpened.length === 0 ? "No claims changed in this version." : null,
    reack,
    counts: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length },
  };
}

function scoreLinesFromDiff(diff: SnapshotDiff): string[] {
  const pctOf = (x: number) => `${Math.round(x * 100)}%`;
  const kOf = (v: number | null) => (v === null ? "n/a" : pctOf(v));
  const a: Scores = diff.scores.after;
  const p = diff.scores.before;
  if (!p) return [`B is ${a.b}.`, `C is ${pctOf(a.c)}.`, `K is ${kOf(a.k)}.`];
  return [
    p.b === a.b ? `B stayed at ${a.b}.` : `B went from ${p.b} to ${a.b}.`,
    pctOf(p.c) === pctOf(a.c) ? `C stayed at ${pctOf(a.c)}.` : `C went from ${pctOf(p.c)} to ${pctOf(a.c)}.`,
    kOf(p.k) === kOf(a.k) ? `K stayed at ${kOf(a.k)}.` : `K went from ${kOf(p.k)} to ${kOf(a.k)}.`,
  ];
}

/** Every string the panel shows this role for one version, in reading order. */
export function changeViewTexts(v: ChangeView): string[] {
  return [v.heading, v.sub, v.causeLine, v.why, ...v.claims.map((c) => c.text), ...v.gaps, v.plan, ...v.scores, v.stub, v.empty, v.reack]
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

/** The panel of the latest snapshot for a role; null when there is no snapshot. */
export async function latestChange(ws: string, role: RoleKey): Promise<ChangeView | null> {
  const [row] = await db()`SELECT id FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC LIMIT 1`;
  return row ? whatChanged(ws, role, String(row.id)) : null;
}

/** The panels of every version for a role, newest first. */
export async function listChanges(ws: string, role: RoleKey): Promise<ChangeView[]> {
  const rows = await db()`SELECT id FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC`;
  const out: ChangeView[] = [];
  for (const r of rows) {
    const v = await whatChanged(ws, role, String(r.id));
    if (v) out.push(v);
  }
  return out;
}

/**
 * Every string the "What changed" panels show `role`, for every version. Handed to the leak grid
 * (improvement 2) as the surface "changes": none of it may contain a token outside the role's
 * permissions.
 */
export async function changeTexts(ws: string, role: RoleKey): Promise<string[]> {
  return (await listChanges(ws, role)).flatMap(changeViewTexts);
}

/**
 * Every string the First weeks page shows `role`: gap rows with their plan, and the findings the
 * role may see with their evidence. The leak grid surface "first weeks".
 */
export async function firstWeeksTexts(ws: string, role: RoleKey): Promise<string[]> {
  const [fw, findings] = await Promise.all([firstWeeks(ws, role), listFindings(ws, role)]);
  const out: string[] = [];
  for (const g of [...fw.blocking, ...fw.other, ...fw.closed]) {
    out.push(`${g.responsibilityTitle}: ${g.checkLabel}`);
    if (g.plan) out.push(g.plan.owner, g.plan.dueDate, g.plan.riskNote);
    if (g.rejectedReason) out.push(g.rejectedReason);
    if (g.example && g.canRecord) out.push(g.example.answer, g.example.note);
  }
  for (const f of findings) {
    out.push(f.gap, f.answer, f.note, f.statement, f.evidenceText);
    if (f.link) out.push(f.link);
    if (f.fileName) out.push(f.fileName);
    if (f.fileText) out.push(f.fileText);
    if (f.reviewNote) out.push(f.reviewNote);
    if (f.scoreDelta) out.push(f.scoreDelta);
    for (const r of [...f.agrees, ...f.disagrees]) out.push(r.statement);
  }
  return out.filter((s) => typeof s === "string" && s.length > 0);
}

/** Findings waiting for the approver, as the role sees them (the Review group). */
export async function listPendingFindings(ws: string, role: RoleKey): Promise<FindingView[]> {
  return (await listFindings(ws, role)).filter((f) => f.status === "pending");
}

/** Claim ids of findings that still wait for review, to keep them out of the tier lists (ids only). */
export async function undecidedFindingClaimIds(ws: string): Promise<Set<string>> {
  const rows = await db()`SELECT claim_id FROM findings WHERE workspace_id = ${ws} AND status IN ('pending', 'withdrawn')`;
  return new Set(rows.map((r) => String(r.claim_id)));
}

/** Approved findings no snapshot carries yet (the release rule blocked it): shown with the blocker. */
export async function waitingForRelease(ws: string, role: RoleKey): Promise<FindingView[]> {
  return (await listFindings(ws, role)).filter((f) => f.status === "approved" && f.version === null);
}
