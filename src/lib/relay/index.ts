// Relay: review, release rule, hashed snapshots (database layer over the pure core in ./core).
// Contract: docs/ARCHITECTURE.md section 4 "Review and Handover" and section 5.
//
// Public entry points (names kept from the walking skeleton):
//   reviewClaim(ws, claimId, decision, actor, opts?)  -> ActionResult    approve / edit / reject one claim
//   bulkApprove(ws, actor)                            -> ActionResult & { approved }   pending tier A only
//   approveSnapshot(ws, actor)                        -> ActionResult & { snapshot? }  hash + release rule
//   compileHandover(ws, role)                         -> Handover        per-role I-PASS doc read under RLS
//   canonicalJson(value)                              -> string          stable key order (hash input)
//   stubLine(n, pack)                                 -> string          the exact restricted-stub text
// Plus: getReleaseInfo, listReviewClaims, listSnapshotHistory, previewSnapshotPayload,
// checkHandoverReadback, acknowledgeHandover, listAcknowledgements, exportMarkdown, runLeakCheck.
//
// Every rule lives in the tested core (applyReview, bulkApproveTierA, computeReleaseState,
// buildSnapshotPayload, hashSnapshot, approveSnapshot, compileHandover, checkReadback, ackRecord,
// scanForCanaries). This file only reads and writes rows and logs every action.
import * as lacuna from "@/lib/lacuna";
import { listBlockingGaps } from "@/lib/lacuna";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { toClaim, toSnapshot } from "@/lib/db/mappers";
import { audit, getLatestTestRun, listClaims } from "@/lib/db/queries";
import { approvalRoles, getWorkspacePack, roleLabel, type ResolvedPack } from "@/lib/pack";
import type { Claim, PlanItem, ReviewState, ReviewTier, RoleKey, Scores, Snapshot } from "@/lib/types";
import { assignTier, applyReview, bulkApproveTierA, type ReviewAction } from "./core/review";
import {
  approveSnapshot as coreApproveSnapshot, buildSnapshotPayload, canonicalJson as coreCanonicalJson,
  computeReleaseState, diffSnapshots, releaseLabel, verifySnapshot,
  type ReleaseState, type SnapshotDiff, type SnapshotPayload,
} from "./core/snapshot";
import { checkApprover } from "./core/labels";
import { stubText } from "./core/compile";
import { parsePayload } from "./handover";

export {
  compileHandover, checkHandoverReadback, acknowledgeHandover, listAcknowledgements, exportMarkdown,
  runLeakCheck, resolveReadbackItems, parsePayload, ATTRIBUTE_ORDER,
  type Handover, type HandoverItem, type ReadbackCheck, type AckRow, type LeakReport, type LeakCell,
} from "./handover";

export type ActionResult = { ok: true } | { ok: false; error: string; code?: string };

/** JSON with object keys sorted at every level (arrays keep their order). The snapshot hash input. */
export function canonicalJson(value: unknown): string {
  return coreCanonicalJson(value);
}

/** Exactly "N restricted items. Ask the approver (<approver label>)." ("1 restricted item." for one). */
export function stubLine(n: number, pack: Pick<ResolvedPack, "roles" | "approverRole">): string {
  const label = roleLabel(pack.approverRole, pack);
  return stubText(n, label) ?? `0 restricted items. Ask the approver (${label}).`;
}

function gate(actor: RoleKey, pack: ResolvedPack): ActionResult {
  const roles = approvalRoles(pack);
  const err = checkApprover(actor, roles);
  if (!err) return { ok: true };
  if (err.code === "leaver_cannot_approve") {
    return { ok: false, code: err.code, error: `The leaver can never review or approve the handover. Switch to ${roles.approverLabel}.` };
  }
  return { ok: false, code: err.code, error: `Only the approver (${roles.approverLabel}) can do this.` };
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------

/**
 * The tier used for review: the stored tier, raised to C whenever the contract rule says C
 * (sensitive, conflicting or blocking). A sensitive claim can never slip into bulk approval.
 */
export function effectiveTier(c: Claim, pack: Pick<ResolvedPack, "restrictedAudienceRoles">): ReviewTier {
  if (c.tier === "C" || assignTier(c, pack.restrictedAudienceRoles) === "C") return "C";
  return c.tier;
}

/** Claims as review sees them (tier made effective). Pass `role` for a read under RLS. */
export async function listReviewClaims(ws: string, role?: RoleKey): Promise<Claim[]> {
  const pack = await getWorkspacePack(ws);
  const claims = await listClaims(ws, role ? { role } : {});
  return claims.map((c) => ({ ...c, tier: effectiveTier(c, pack) }));
}

export async function reviewClaim(
  ws: string,
  claimId: string,
  decision: Exclude<ReviewState, "pending">,
  actor: RoleKey,
  opts: { note?: string; statement?: string; value?: string; evidenceOpened?: boolean } = {},
): Promise<ActionResult> {
  const pack = await getWorkspacePack(ws);
  const g = gate(actor, pack);
  if (!g.ok) return g;
  const sql = db();
  const [row] = await sql`SELECT * FROM claims WHERE workspace_id = ${ws} AND id = ${claimId}`;
  if (!row) return { ok: false, error: "Claim not found." };
  const stored = toClaim(row);
  const claim = { ...stored, tier: effectiveTier(stored, pack) };
  const action: ReviewAction = {
    type: decision === "approved" ? "approve" : decision === "rejected" ? "reject" : "edit",
    by: actor,
    note: opts.note,
    newStatement: opts.statement,
    newValue: opts.value,
    evidenceOpened: opts.evidenceOpened === true,
  };
  const res = applyReview(claim, action, approvalRoles(pack));
  if (!res.ok) return { ok: false, code: res.code, error: res.message };
  const next = res.claim;
  // Citations and trust are never touched by a review: an edit keeps them as they were.
  await sql.begin(async (tx) => {
    await tx`
      UPDATE claims SET review = ${next.review}, review_note = ${next.reviewNote}, value = ${next.value},
        statement = ${next.statement}, updated_at = now()
      WHERE workspace_id = ${ws} AND id = ${claimId}`;
    await tx`INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
      VALUES (${ws}, ${claimId}, ${res.event.type}, ${JSON.stringify({ ...res.event.payload, at: res.event.at })}::jsonb, ${actor})`;
  });
  await audit(ws, actor, "review_claim", { claimId, decision, tier: claim.tier, evidenceOpened: action.evidenceOpened === true });
  return { ok: true };
}

/** Approve every pending tier A claim (active). Tiers B and C are never bulk-approved. */
export async function bulkApprove(
  ws: string, actor: RoleKey, _tiers?: ReviewTier[],
): Promise<ActionResult & { approved?: number }> {
  void _tiers; // kept for call-site compatibility; bulk approval is tier A only.
  const pack = await getWorkspacePack(ws);
  const g = gate(actor, pack);
  if (!g.ok) return g;
  const sql = db();
  const claims = (await sql`SELECT * FROM claims WHERE workspace_id = ${ws} AND review = 'pending' ORDER BY id`)
    .map(toClaim).map((c) => ({ ...c, tier: effectiveTier(c, pack) }));
  const res = bulkApproveTierA(claims, actor, approvalRoles(pack));
  if (!res.ok) return { ok: false, code: res.code, error: res.message };
  if (res.approvedIds.length) {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE claims SET review = 'approved', updated_at = now()
        WHERE workspace_id = ${ws} AND review = 'pending' AND id = ANY(${res.approvedIds}::text[])`;
      for (const e of res.events) {
        await tx`INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
          VALUES (${ws}, ${e.claimId}, ${e.type}, ${JSON.stringify({ ...e.payload, at: e.at })}::jsonb, ${actor})`;
      }
    });
  }
  await audit(ws, actor, "bulk_approve", { tier: "A", count: res.approvedIds.length });
  return { ok: true, approved: res.approvedIds.length };
}

// ---------------------------------------------------------------------------------------------
// Release rule
// ---------------------------------------------------------------------------------------------

export interface GapView {
  responsibilityId: string;
  responsibilityTitle: string;
  checkKey: string;
  checkLabel: string;
  coverage: string;
  plan: PlanItem | null;
}

export interface ReleaseInfo {
  state: ReleaseState;
  /** "Released with N open blocking gaps" (never "complete"). */
  line: string;
  scores: Scores;
  gaps: GapView[];
  /** Plan items for the open blocking gaps (the plan that goes into the snapshot). */
  plan: PlanItem[];
  approvedClaims: number;
  /** Exact reasons the approval is blocked; empty when it may go ahead. */
  blockers: string[];
}

const NO_SCORES: Scores = { b: 0, c: 0, k: null };
const MISSING_WORD = { plan: "an owner, a due date and a risk note", owner: "an owner", dueDate: "a due date", riskNote: "a risk note" } as const;

function toGapView(g: unknown): GapView {
  const r = g as Record<string, unknown>;
  const plan = (r.plan ?? null) as PlanItem | null;
  return {
    responsibilityId: String(r.responsibilityId ?? ""),
    responsibilityTitle: String(r.responsibilityTitle ?? r.title ?? r.responsibilityId ?? ""),
    checkKey: String(r.checkKey ?? ""),
    checkLabel: String(r.checkLabel ?? r.checkKey ?? ""),
    coverage: String(r.coverage ?? "missing"),
    plan: plan ? { ...plan, dueDate: plan.dueDate ? String(plan.dueDate).slice(0, 10) : "" } : null,
  };
}

function joinWords(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Lacuna's own release summary when it exports one (optional); the gate below never depends on it. */
async function lacunaReleaseLine(ws: string): Promise<string | null> {
  const key = "releaseInfo";
  const fn = (lacuna as unknown as Record<string, unknown>)[key];
  if (typeof fn !== "function") return null;
  try {
    const info = (await (fn as (w: string) => Promise<unknown>)(ws)) as Record<string, unknown> | null;
    for (const k of ["label", "line", "releaseLine", "releaseLabel"]) {
      const v = info?.[k];
      if (typeof v === "string" && /^Released with/.test(v)) return v;
    }
  } catch {
    // fall through to the core label
  }
  return null;
}

/** The release state now: scores of the successor's latest test, open blocking gaps, their plan. */
export async function getReleaseInfo(ws: string): Promise<ReleaseInfo> {
  const pack = await getWorkspacePack(ws);
  const [run, rawGaps, approvedRow, lacunaLine] = await Promise.all([
    getLatestTestRun(ws, pack.successorRole as RoleKey),
    listBlockingGaps(ws),
    db()`SELECT count(*)::int AS n FROM claims WHERE workspace_id = ${ws}
      AND review IN ('approved', 'edited') AND state NOT IN ('dropped', 'superseded')`,
    lacunaReleaseLine(ws),
  ]);
  const gaps = (rawGaps as unknown[]).map(toGapView);
  const scores = run?.scores ?? NO_SCORES;
  const plan = gaps.filter((g) => g.plan).map((g) => ({ ...g.plan!, responsibilityId: g.responsibilityId, checkKey: g.checkKey }));
  const state = computeReleaseState({ scores, blockingGaps: gaps, plan });
  const approvedClaims = Number(approvedRow[0]?.n ?? 0);

  const blockers: string[] = [];
  if (scores.b > gaps.length) blockers.push(`B is ${scores.b} but only ${gaps.length} blocking gaps are listed for the plan. Re-run the test.`);
  for (const p of state.problems) {
    const g = gaps.find((x) => x.responsibilityId === p.responsibilityId && x.checkKey === p.checkKey);
    const what = g ? `${g.responsibilityTitle}: ${g.checkLabel}` : `${p.responsibilityId}: ${p.checkKey}`;
    blockers.push(`${what} needs ${joinWords(p.missing.map((m) => MISSING_WORD[m]))}.`);
  }
  if (approvedClaims === 0) blockers.push("No approved claims yet: approve at least one claim first.");
  return { state, line: lacunaLine ?? state.label, scores, gaps, plan, approvedClaims, blockers };
}

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

async function segmentVersions(ws: string, claims: Claim[]): Promise<Record<string, number>> {
  const ids = [...new Set(claims.flatMap((c) => c.citations.filter((x) => x.accepted).map((x) => x.segmentId)))];
  const out: Record<string, number> = {};
  if (!ids.length) return out;
  const rows = await db()`
    SELECT id, max(version)::int AS v FROM segments WHERE workspace_id = ${ws} AND id = ANY(${ids}::text[]) GROUP BY id`;
  for (const r of rows) out[String(r.id)] = Number(r.v);
  return out;
}

async function snapshotInputs(ws: string) {
  const claims = (await db()`SELECT * FROM claims WHERE workspace_id = ${ws} ORDER BY id`).map(toClaim);
  const [versions, release] = await Promise.all([segmentVersions(ws, claims), getReleaseInfo(ws)]);
  return { claims, versions, release };
}

/** The payload a snapshot with this version number would hash right now (admin read). */
export async function previewSnapshotPayload(ws: string, version: number): Promise<SnapshotPayload> {
  const { claims, versions, release } = await snapshotInputs(ws);
  return buildSnapshotPayload({
    workspaceId: ws, version, claims, segmentVersions: versions,
    plan: release.plan, scores: release.scores, openBlocking: release.state.openBlocking,
  });
}

export async function approveSnapshot(
  ws: string, actor: RoleKey,
): Promise<ActionResult & { snapshot?: Snapshot; label?: string }> {
  const pack = await getWorkspacePack(ws);
  const g = gate(actor, pack);
  if (!g.ok) return g;
  const sql = db();
  const { claims, versions, release } = await snapshotInputs(ws);
  const [{ v: maxVersion }] = await sql`SELECT coalesce(max(version), 0)::int AS v FROM snapshots WHERE workspace_id = ${ws}`;
  const version = Number(maxVersion) + 1;
  const payload = buildSnapshotPayload({
    workspaceId: ws, version, claims, segmentVersions: versions,
    plan: release.plan, scores: release.scores, openBlocking: release.state.openBlocking,
  });
  const res = coreApproveSnapshot({ by: actor, roles: approvalRoles(pack), releaseState: release.state, payload });
  if (!res.ok) {
    const detail = res.code === "release_blocked" && release.blockers.length ? ` ${release.blockers.join(" ")}` : "";
    const lead = res.code === "release_blocked"
      ? `B is ${release.state.openBlocking}: every open blocking gap needs an owner, a due date and a risk note before release.`
      : res.message;
    return { ok: false, code: res.code, error: `${lead}${detail}` };
  }

  const id = `snap_v${version}`;
  const byId = new Map(claims.map((c) => [c.id, c]));
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO snapshots (workspace_id, id, version, hash, approved_by, approved_at, claim_ids, open_blocking, plan, payload)
      VALUES (${ws}, ${id}, ${version}, ${res.snapshot.hash}, ${actor}, ${res.snapshot.approvedAt}, ${res.snapshot.claimIds}::text[],
        ${payload.openBlocking}, ${JSON.stringify(payload.plan)}::jsonb, ${coreCanonicalJson(payload)}::jsonb)`;
    for (const pc of payload.claims) {
      const c = byId.get(pc.id)!;
      await tx`
        INSERT INTO snapshot_claims (workspace_id, snapshot_id, claim_id, entity, entity_label, attribute, statement, value,
          trust, state, review, importance, valid_from, citations, role_set, flag_role_set)
        VALUES (${ws}, ${id}, ${c.id}, ${c.entity}, ${c.entityLabel}, ${c.attribute}, ${c.statement}, ${c.value},
          ${c.trust}, ${c.state === "conflicting" ? "conflicting" : "active"}, ${c.review === "edited" ? "edited" : "approved"},
          ${c.importance}, ${c.validFrom}, ${JSON.stringify(c.citations)}::jsonb, ${pc.roleSet}::text[],
          ${c.flagRoleSet ?? null}::text[])`;
    }
    // The approved snapshot settles the scores it was built on: the latest run per role stops being provisional.
    await tx`
      UPDATE test_runs SET provisional = false
      WHERE workspace_id = ${ws} AND id IN (
        SELECT DISTINCT ON (role) id FROM test_runs WHERE workspace_id = ${ws} ORDER BY role, created_at DESC)`;
  });
  await audit(ws, actor, "approve_snapshot", { ...res.event.payload, id });
  const [row] = await sql`SELECT * FROM snapshots WHERE workspace_id = ${ws} AND id = ${id}`;
  return { ok: true, snapshot: toSnapshot(row), label: res.label };
}

export interface SnapshotHistoryEntry {
  snapshot: Snapshot;
  label: string;
  verified: boolean;
  claimCount: number;
  diff: SnapshotDiff | null;
}

/** Every snapshot of the workspace, newest first, with its hash check and the diff to the previous one. */
export async function listSnapshotHistory(ws: string): Promise<SnapshotHistoryEntry[]> {
  const rows = await db()`SELECT * FROM snapshots WHERE workspace_id = ${ws} ORDER BY version ASC`;
  const out: SnapshotHistoryEntry[] = [];
  let prev: SnapshotPayload | null = null;
  for (const r of rows) {
    const snapshot = toSnapshot(r);
    const payload = parsePayload(r.payload);
    out.push({
      snapshot,
      label: releaseLabel(snapshot.openBlocking),
      verified: payload ? verifySnapshot(payload, snapshot.hash) : false,
      claimCount: snapshot.claimIds.length,
      diff: payload ? diffSnapshots(prev, payload) : null,
    });
    if (payload) prev = payload;
  }
  return out.reverse();
}

/** Re-hash the stored payload of one snapshot. */
export async function verifyStoredSnapshot(ws: string, snapshotId: string): Promise<boolean> {
  const [r] = await db()`SELECT hash, payload FROM snapshots WHERE workspace_id = ${ws} AND id = ${snapshotId}`;
  if (!r) return false;
  const payload = parsePayload(r.payload);
  return payload ? verifySnapshot(payload, String(r.hash)) : false;
}

// ---------------------------------------------------------------------------------------------
// Evidence for inline review (read as the viewing role, under RLS)
// ---------------------------------------------------------------------------------------------

export interface EvidenceSegment {
  segmentId: string;
  text: string;
  sourceName: string;
  ts: string;
  thread: string;
}

/** Latest version of each cited segment the role may see. Missing ids are not visible (or gone). */
export async function loadEvidence(ws: string, role: RoleKey, segmentIds: string[]): Promise<Record<string, EvidenceSegment>> {
  const ids = [...new Set(segmentIds)].filter(Boolean);
  const out: Record<string, EvidenceSegment> = {};
  if (!ids.length) return out;
  const rows = await withRole(ws, role, (tx) => tx`
    SELECT DISTINCT ON (id) id, text, source_id, ts, thread FROM segments
    WHERE workspace_id = ${ws} AND id = ANY(${ids}::text[])
    ORDER BY id, version DESC`);
  const sources = new Map(
    (await db()`SELECT id, name FROM sources WHERE workspace_id = ${ws}`).map((r) => [String(r.id), String(r.name)]),
  );
  for (const r of rows) {
    out[String(r.id)] = {
      segmentId: String(r.id),
      text: String(r.text),
      sourceName: sources.get(String(r.source_id)) ?? String(r.source_id),
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      thread: String(r.thread),
    };
  }
  return out;
}
