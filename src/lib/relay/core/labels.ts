// Shared Relay vocabulary and small helpers. Exact strings come from docs/ARCHITECTURE.md section 2.
import type { Attribute, RoleKey } from "@/lib/types";

/**
 * The role facts the approval rules need, read from the workspace's pack (approvalRoles(pack)):
 * `approver` is the only role that may review claims and approve snapshots (ARCHITECTURE
 * section 4); the leaver role is the leaving person, who can never review or approve.
 */
export interface ApprovalRoles {
  approver: RoleKey;
  leaver: RoleKey;
  /** The approver's label from the pack, used in stub, conflict and error text. */
  approverLabel: string;
}

// The trust ladder is written once in src/lib/trust.ts.
export { TRUST_LABEL, TRUST_ORDER, weakestTrust } from "@/lib/trust";

/**
 * Shown under the scores when the release label's open gap count differs from B: a restricted blocking
 * gap with a named owner in the continuation plan leaves B but stays open.
 */
export const OPEN_GAPS_NOTE =
  "B counts blocking gaps nobody owns yet. Open gaps include the ones with an owner in the continuation plan.";

/** Label shown next to any claim text a reviewer edited. Trust is never raised by an edit. */
export const REVIEWER_EDITED_LABEL = "edited by reviewer";

export const ATTRIBUTE_LABEL: Record<Attribute, string> = {
  owner: "owner",
  status: "status",
  deadline: "deadline",
  location: "location",
  procedure: "procedure",
  access: "access",
  decision: "decision",
  reason: "reason",
  dependency: "dependency",
  contact: "contact",
  risk: "risk",
};

/** Relay operations return a value or a typed error; they never throw for rule violations. */
export type RelayErrorCode =
  | "not_approver"
  | "leaver_cannot_approve"
  | "evidence_not_opened"
  | "reason_required"
  | "edit_empty"
  | "not_reviewable"
  | "release_blocked"
  | "payload_mismatch"
  | "empty_snapshot";

export interface RelayError {
  ok: false;
  code: RelayErrorCode;
  message: string;
}

export function relayError(code: RelayErrorCode, message: string): RelayError {
  return { ok: false, code, message };
}

/** Role check shared by review and snapshot approval. Returns an error or null. */
export function checkApprover(by: RoleKey, roles: ApprovalRoles): RelayError | null {
  if (by === roles.leaver) {
    return relayError("leaver_cannot_approve", "The leaver can never review or approve the handover.");
  }
  if (by !== roles.approver) {
    return relayError("not_approver", `Only the approver (${roles.approverLabel}) may review or approve; got ${by}.`);
  }
  return null;
}
