// Snapshot payload, canonical JSON, SHA-256 hash, release rule and approval (Relay).
// Pure. Contract: docs/ARCHITECTURE.md section 4, "Review and Handover".
import { createHash } from "node:crypto";
import type { Attribute, Claim, PlanItem, RoleKey, Scores, Snapshot, Trust } from "@/lib/types";
import { checkApprover, relayError, type ApprovalRoles, type RelayError } from "./labels";
import type { RelayEvent } from "./review";

// ---------------------------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted (UTF-16 code unit order), no whitespace, arrays kept in order,
 * `undefined` object members omitted (as JSON.stringify does). Throws on values JSON cannot represent
 * faithfully (non-finite numbers, bigint, functions, symbols, undefined at top level or in arrays).
 */
export function canonicalJson(x: unknown): string {
  if (x === null) return "null";
  switch (typeof x) {
    case "string":
      return JSON.stringify(x);
    case "boolean":
      return x ? "true" : "false";
    case "number":
      if (!Number.isFinite(x)) throw new Error(`canonicalJson: non-finite number ${x}`);
      return JSON.stringify(x);
    case "object": {
      if (Array.isArray(x)) {
        return "[" + x.map((v) => {
          if (v === undefined) throw new Error("canonicalJson: undefined inside an array");
          return canonicalJson(v);
        }).join(",") + "]";
      }
      if (x instanceof Date) return JSON.stringify(x.toISOString());
      const obj = x as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof x}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------------------------

export const SNAPSHOT_SCHEMA = "understudy.snapshot/1";

export interface SnapshotClaim {
  id: string;
  statement: string;
  value: string;
  attribute: Attribute;
  entity: string;
  trust: Trust;
  roleSet: RoleKey[];
  citations: { segmentId: string; version: number }[];
}

export interface SnapshotPayload {
  schema: typeof SNAPSHOT_SCHEMA;
  workspaceId: string;
  version: number;
  claims: SnapshotClaim[];
  plan: PlanItem[];
  scores: Scores;
  openBlocking: number;
}

export interface BuildSnapshotInput {
  workspaceId: string;
  version: number;
  /** Any claims; only reviewed-in claims (approved or edited, not dropped or superseded) are kept. */
  claims: readonly Claim[];
  /** Segment id -> segment version. A segment missing here is taken as version 1. */
  segmentVersions?: Readonly<Record<string, number>>;
  plan: readonly PlanItem[];
  scores: Scores;
  openBlocking: number;
}

const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** True for claims that belong in a snapshot. */
export function isSnapshotClaim(c: Claim): boolean {
  return (c.review === "approved" || c.review === "edited") && c.state !== "dropped" && c.state !== "superseded";
}

/**
 * Build the hashed payload. Claims sorted by id; role sets sorted; only accepted citations, sorted by
 * segment id then version; plan sorted by responsibility then check. Same content => same payload.
 */
export function buildSnapshotPayload(input: BuildSnapshotInput): SnapshotPayload {
  const versions = input.segmentVersions ?? {};
  const claims: SnapshotClaim[] = input.claims
    .filter(isSnapshotClaim)
    .map((c) => {
      const seen = new Set<string>();
      const citations: { segmentId: string; version: number }[] = [];
      for (const cit of c.citations) {
        if (!cit.accepted) continue;
        const version = versions[cit.segmentId] ?? 1;
        const key = `${cit.segmentId}@${version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        citations.push({ segmentId: cit.segmentId, version });
      }
      citations.sort((a, b) => byStr(a.segmentId, b.segmentId) || a.version - b.version);
      return {
        id: c.id,
        statement: c.statement,
        value: c.value,
        attribute: c.attribute,
        entity: c.entity,
        trust: c.trust,
        roleSet: [...new Set(c.roleSet)].sort(byStr),
        citations,
      };
    })
    .sort((a, b) => byStr(a.id, b.id));

  const plan = input.plan
    .map((p) => ({ ...p }))
    .sort((a, b) => byStr(a.responsibilityId, b.responsibilityId) || byStr(a.checkKey, b.checkKey));

  return {
    schema: SNAPSHOT_SCHEMA,
    workspaceId: input.workspaceId,
    version: input.version,
    claims,
    plan,
    scores: { b: input.scores.b, c: input.scores.c, k: input.scores.k },
    openBlocking: input.openBlocking,
  };
}

/** sha256 hex of the canonical JSON of the payload. */
export function hashSnapshot(payload: SnapshotPayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/** True when the payload hashes to the given hex hash (case-insensitive). */
export function verifySnapshot(payload: SnapshotPayload, hash: string): boolean {
  return hashSnapshot(payload) === hash.trim().toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Release rule
// ---------------------------------------------------------------------------------------------

export interface BlockingGap {
  responsibilityId: string;
  checkKey: string;
}

export interface PlanProblem {
  responsibilityId: string;
  checkKey: string;
  missing: ("plan" | "owner" | "dueDate" | "riskNote")[];
}

export interface ReleaseState {
  canApprove: boolean;
  openBlocking: number;
  label: string;
  problems: PlanProblem[];
  reasons: string[];
}

/** "Released with N open blocking gaps" (singular for 1). Never "complete". */
export function releaseLabel(openBlocking: number): string {
  const n = Math.max(0, Math.floor(openBlocking));
  if (n === 0) return "Released with no open blocking gaps";
  return n === 1 ? "Released with 1 open blocking gap" : `Released with ${n} open blocking gaps`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function isValidIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s.trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Release rule: B > 0 cannot be approved until every open blocking gap has an owner, a due date and the
 * approver's risk note in the continuation plan.
 */
export function computeReleaseState(input: {
  scores: Scores;
  blockingGaps: readonly BlockingGap[];
  plan: readonly PlanItem[];
}): ReleaseState {
  const { scores, blockingGaps, plan } = input;
  const reasons: string[] = [];
  const problems: PlanProblem[] = [];
  const openBlocking = Math.max(scores.b, blockingGaps.length);

  if (scores.b > blockingGaps.length) {
    reasons.push(`B is ${scores.b} but only ${blockingGaps.length} blocking gaps are listed for the plan.`);
  }
  for (const gap of blockingGaps) {
    const item = plan.find((p) => p.responsibilityId === gap.responsibilityId && p.checkKey === gap.checkKey);
    const missing: PlanProblem["missing"] = [];
    if (!item) missing.push("plan");
    else {
      if (!item.owner?.trim()) missing.push("owner");
      if (!item.dueDate?.trim() || !isValidIsoDate(item.dueDate)) missing.push("dueDate");
      if (!item.riskNote?.trim()) missing.push("riskNote");
    }
    if (missing.length) problems.push({ responsibilityId: gap.responsibilityId, checkKey: gap.checkKey, missing });
  }
  if (problems.length) {
    reasons.push(`${problems.length} open blocking gap(s) need an owner, a due date and a risk note.`);
  }
  return { canApprove: reasons.length === 0, openBlocking, label: releaseLabel(openBlocking), problems, reasons };
}

// ---------------------------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------------------------

export type ApproveResult =
  | { ok: true; snapshot: Snapshot; label: string; payload: SnapshotPayload; event: RelayEvent }
  | RelayError;

/**
 * Approve a snapshot. Only the pack's approver role; the leaver never; the release rule must hold.
 * The snapshot id is derived from the hash; a database layer may replace it with its own key.
 */
export function approveSnapshot(input: {
  by: RoleKey;
  roles: ApprovalRoles;
  releaseState: ReleaseState;
  payload: SnapshotPayload;
  at?: string;
}): ApproveResult {
  const { by, releaseState, payload } = input;
  const roleError = checkApprover(by, input.roles);
  if (roleError) return roleError;
  if (!releaseState.canApprove) {
    return relayError("release_blocked", releaseState.reasons.join(" ") || "Release rule not met.");
  }
  if (payload.openBlocking !== releaseState.openBlocking) {
    return relayError(
      "payload_mismatch",
      `Payload says ${payload.openBlocking} open blocking gaps; release state says ${releaseState.openBlocking}.`,
    );
  }
  if (payload.claims.length === 0) {
    return relayError("empty_snapshot", "No approved claims: nothing to hand over.");
  }
  const hash = hashSnapshot(payload);
  const at = input.at ?? new Date().toISOString();
  const label = releaseLabel(payload.openBlocking);
  const snapshot: Snapshot = {
    id: `snap_${hash.slice(0, 16)}`,
    workspaceId: payload.workspaceId,
    version: payload.version,
    hash,
    approvedBy: by,
    approvedAt: at,
    claimIds: payload.claims.map((c) => c.id),
    openBlocking: payload.openBlocking,
    plan: payload.plan.map((p) => ({ ...p })),
  };
  const event: RelayEvent = {
    type: "snapshot_approved",
    claimId: null,
    by,
    at,
    payload: { version: payload.version, hash, openBlocking: payload.openBlocking, label, claimCount: payload.claims.length },
  };
  return { ok: true, snapshot, label, payload, event };
}

// ---------------------------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------------------------

export interface SnapshotDiff {
  fromVersion: number | null;
  toVersion: number;
  added: string[];
  removed: string[];
  changed: string[];
  planChanged: boolean;
  scores: { before: Scores | null; after: Scores };
  openBlocking: { before: number | null; after: number };
}

/** Claim-level diff between two snapshot payloads (prev may be null for v1). Ids sorted. */
export function diffSnapshots(prev: SnapshotPayload | null, next: SnapshotPayload): SnapshotDiff {
  const before = new Map((prev?.claims ?? []).map((c) => [c.id, canonicalJson(c)]));
  const after = new Map(next.claims.map((c) => [c.id, canonicalJson(c)]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, json] of after) {
    const old = before.get(id);
    if (old === undefined) added.push(id);
    else if (old !== json) changed.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return {
    fromVersion: prev?.version ?? null,
    toVersion: next.version,
    added: added.sort(byStr),
    removed: removed.sort(byStr),
    changed: changed.sort(byStr),
    planChanged: canonicalJson(prev?.plan ?? []) !== canonicalJson(next.plan),
    scores: { before: prev?.scores ?? null, after: next.scores },
    openBlocking: { before: prev?.openBlocking ?? null, after: next.openBlocking },
  };
}
