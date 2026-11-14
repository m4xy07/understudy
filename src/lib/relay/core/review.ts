// Claim review (Relay). Pure: takes a claim and an action, returns the new claim and one
// append-only event, or a typed error. Contract: docs/ARCHITECTURE.md section 4, "Review and Handover".
import type { Claim, Responsibility, ReviewTier, RoleKey } from "@/lib/types";
import { checkApprover, relayError, type ApprovalRoles, type RelayError } from "./labels";

export type ReviewActionType = "approve" | "reject" | "edit";

export interface ReviewAction {
  type: ReviewActionType;
  by: RoleKey;
  note?: string;
  newValue?: string;
  newStatement?: string;
  evidenceOpened?: boolean;
  /** ISO time of the action; defaults to now. Pass it for deterministic tests and replays. */
  at?: string;
}

export type RelayEventType =
  | "claim_approved"
  | "claim_rejected"
  | "claim_edited"
  | "snapshot_approved";

/** One row of the append-only log. Never updated or deleted. */
export interface RelayEvent {
  type: RelayEventType;
  claimId: string | null;
  by: RoleKey;
  at: string;
  payload: Record<string, unknown>;
}

export type ReviewResult = { ok: true; claim: Claim; event: RelayEvent } | RelayError;

/** Minimum length of the written reason a tier C review needs. */
export const TIER_C_MIN_NOTE = 10;

const EVENT_TYPE: Record<ReviewActionType, RelayEventType> = {
  approve: "claim_approved",
  reject: "claim_rejected",
  edit: "claim_edited",
};

/**
 * Review tier from the contract: C = sensitive (hidden from a role the pack flags as restricted
 * audience), conflicting, or blocking importance; A = corroborated, normal, no flags (bulk
 * approve); B = everything else.
 */
export function assignTier(claim: Claim, restrictedAudience: readonly RoleKey[]): ReviewTier {
  const sensitive = restrictedAudience.some((r) => !claim.roleSet.includes(r));
  if (sensitive || claim.state === "conflicting" || claim.importance === "blocking") return "C";
  const flagged =
    claim.state !== "active" ||
    claim.supportCheck === "no" ||
    claim.supportCheck === "partly" ||
    claim.stateNote !== null;
  if (claim.trust === "corroborated" && claim.importance === "normal" && !flagged) return "A";
  return "B";
}

/** True when the claim text shown to people was changed by a reviewer. */
export function isReviewerEdited(claim: Pick<Claim, "review">): boolean {
  return claim.review === "edited";
}

/** Apply one review action. Only the approver may review; the leaver never. */
export function applyReview(claim: Claim, action: ReviewAction, roles: ApprovalRoles): ReviewResult {
  const roleError = checkApprover(action.by, roles);
  if (roleError) return roleError;

  if (claim.state === "dropped") {
    return relayError("not_reviewable", `Claim ${claim.id} was dropped (no accepted citation) and cannot be reviewed.`);
  }
  if (claim.state === "superseded" && action.type !== "reject") {
    return relayError("not_reviewable", `Claim ${claim.id} is superseded; only reject is allowed.`);
  }

  const note = (action.note ?? "").trim();
  if (claim.tier === "C") {
    if (action.evidenceOpened !== true) {
      return relayError("evidence_not_opened", "Tier C: open the evidence before deciding.");
    }
    if (note.length < TIER_C_MIN_NOTE) {
      return relayError("reason_required", `Tier C: write a reason of at least ${TIER_C_MIN_NOTE} characters.`);
    }
  }

  const at = action.at ?? new Date().toISOString();
  const before = { review: claim.review, value: claim.value, statement: claim.statement };
  let next: Claim;

  switch (action.type) {
    case "approve":
      next = { ...claim, review: "approved", reviewNote: note || null };
      break;
    case "reject":
      next = { ...claim, review: "rejected", reviewNote: note || null };
      break;
    case "edit": {
      const newValue = action.newValue?.trim();
      const newStatement = action.newStatement?.trim();
      if (!newValue && !newStatement) {
        return relayError("edit_empty", "An edit needs a new value or a new statement.");
      }
      // Citations and trust stay as they were: an edit never upgrades trust.
      next = {
        ...claim,
        value: newValue || claim.value,
        statement: newStatement || claim.statement,
        citations: claim.citations.map((c) => ({ ...c })),
        trust: claim.trust,
        review: "edited",
        reviewNote: note || null,
      };
      break;
    }
  }

  const event: RelayEvent = {
    type: EVENT_TYPE[action.type],
    claimId: claim.id,
    by: action.by,
    at,
    payload: {
      tier: claim.tier,
      note: note || null,
      evidenceOpened: action.evidenceOpened === true,
      before,
      after: { review: next.review, value: next.value, statement: next.statement },
      trust: next.trust,
    },
  };
  return { ok: true, claim: next, event };
}

export type BulkResult =
  | { ok: true; claims: Claim[]; events: RelayEvent[]; approvedIds: string[] }
  | RelayError;

/**
 * Approve every pending tier A claim (active state) in one go. Other claims are returned unchanged.
 * Input order is preserved.
 */
export function bulkApproveTierA(claims: readonly Claim[], by: RoleKey, roles: ApprovalRoles, at?: string): BulkResult {
  const roleError = checkApprover(by, roles);
  if (roleError) return roleError;
  const when = at ?? new Date().toISOString();
  const events: RelayEvent[] = [];
  const approvedIds: string[] = [];
  const out = claims.map((c) => {
    if (c.tier !== "A" || c.review !== "pending" || c.state !== "active") return c;
    approvedIds.push(c.id);
    events.push({
      type: "claim_approved",
      claimId: c.id,
      by,
      at: when,
      payload: {
        tier: "A",
        bulk: true,
        note: null,
        evidenceOpened: false,
        before: { review: c.review, value: c.value, statement: c.statement },
        after: { review: "approved", value: c.value, statement: c.statement },
        trust: c.trust,
      },
    });
    return { ...c, review: "approved" as const };
  });
  return { ok: true, claims: out, events, approvedIds };
}

// ---------------------------------------------------------------------------------------------
// Tier B by responsibility
// ---------------------------------------------------------------------------------------------

/** The entity key extraction gives a claim that belongs to no named topic. */
export const OTHER_ENTITY = "other";

export interface ReviewGroup {
  /** "resp:<responsibility id>" or "topic:<entity key>". Safe to carry in a form. */
  key: string;
  title: string;
  /** The responsibility the group belongs to; null for claims outside every responsibility. */
  responsibilityId: string | null;
  claims: Claim[];
}

/** Can this claim be approved with its group? Pending, tier B, active. Never tier C, a conflict or a superseded claim. */
export function groupApprovable(c: Pick<Claim, "tier" | "review" | "state" | "origin">): boolean {
  return c.tier === "B" && c.review === "pending" && c.state === "active" && c.origin !== "successor_finding";
}

/**
 * Pending tier B claims grouped for review: one group per responsibility (inventory order), then one
 * per remaining topic, the catch-all topic last. A claim sits in exactly one group. Pass claims with
 * their effective tier. Groups with nothing to approve are left out.
 */
export function groupTierB(
  claims: readonly Claim[],
  responsibilities: readonly Pick<Responsibility, "id" | "key" | "title" | "entities">[],
): ReviewGroup[] {
  const resps = [...responsibilities].sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }) || (a.id < b.id ? -1 : 1));
  const byResp = new Map<string, Claim[]>();
  const byTopic = new Map<string, Claim[]>();
  for (const c of claims) {
    if (!groupApprovable(c)) continue;
    const r = resps.find((x) => x.entities.includes(c.entity));
    const [map, key] = r ? [byResp, r.id] : [byTopic, c.entity];
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  const out: ReviewGroup[] = [];
  for (const r of resps) {
    const list = byResp.get(r.id);
    if (list) out.push({ key: `resp:${r.id}`, title: `${r.key} ${r.title}`, responsibilityId: r.id, claims: list });
  }
  const topics = [...byTopic.keys()].sort((a, b) =>
    (a === OTHER_ENTITY ? 1 : 0) - (b === OTHER_ENTITY ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0));
  for (const t of topics) {
    const list = byTopic.get(t)!;
    const label = list[0].entityLabel || t;
    out.push({
      key: `topic:${t}`,
      title: t === OTHER_ENTITY ? "Other: not tied to one topic" : `Other: ${label}`,
      responsibilityId: null,
      claims: list,
    });
  }
  return out;
}

/**
 * Approve the pending tier B claims of one group. `ids` are the claims the approver had on screen:
 * a claim that joined the group since is left for the next look. Other claims are returned unchanged.
 */
export function bulkApproveGroup(
  claims: readonly Claim[], ids: ReadonlySet<string>, groupKey: string, by: RoleKey, roles: ApprovalRoles, at?: string,
): BulkResult {
  const roleError = checkApprover(by, roles);
  if (roleError) return roleError;
  const when = at ?? new Date().toISOString();
  const events: RelayEvent[] = [];
  const approvedIds: string[] = [];
  const out = claims.map((c) => {
    if (!groupApprovable(c) || !ids.has(c.id)) return c;
    approvedIds.push(c.id);
    events.push({
      type: "claim_approved",
      claimId: c.id,
      by,
      at: when,
      payload: {
        tier: "B",
        bulk: true,
        group: groupKey,
        note: null,
        evidenceOpened: false,
        before: { review: c.review, value: c.value, statement: c.statement },
        after: { review: "approved", value: c.value, statement: c.statement },
        trust: c.trust,
      },
    });
    return { ...c, review: "approved" as const };
  });
  return { ok: true, claims: out, events, approvedIds };
}
