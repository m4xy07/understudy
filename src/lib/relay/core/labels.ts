// Shared Relay vocabulary and small helpers. Exact strings come from docs/ARCHITECTURE.md section 2.
import type { Attribute, RoleKey, Trust } from "@/lib/types";

/** The only role that may review claims and approve snapshots (ARCHITECTURE section 4). */
export const APPROVER_ROLE: RoleKey = "president";
/** The leaving person. Can never review or approve, whatever else changes. */
export const LEAVER_ROLE: RoleKey = "leaver";
/** Default approver label, used in stub and conflict text. Callers pass the pack label when it differs. */
export const DEFAULT_APPROVER_LABEL = "Club President";

/** Trust labels in words, strongest first. Nothing a person said is ever labelled verified. */
export const TRUST_LABEL: Record<Trust, string> = {
  from_record: "From record",
  corroborated: "Corroborated",
  leaver_said: "Leaver said",
  second_hand: "Second-hand",
  inferred: "Inferred",
  ranked_options: "Ranked options",
};

export const TRUST_ORDER: readonly Trust[] = [
  "from_record",
  "corroborated",
  "leaver_said",
  "second_hand",
  "inferred",
  "ranked_options",
];

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

/** The weakest trust in a list (the conservative label for a line built from several claims). */
export function weakestTrust(trusts: readonly Trust[]): Trust | null {
  let worst: Trust | null = null;
  for (const t of trusts) {
    if (worst === null || TRUST_ORDER.indexOf(t) > TRUST_ORDER.indexOf(worst)) worst = t;
  }
  return worst;
}

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
export function checkApprover(by: RoleKey): RelayError | null {
  if (by === LEAVER_ROLE) {
    return relayError("leaver_cannot_approve", "The leaver can never review or approve the handover.");
  }
  if (by !== APPROVER_ROLE) {
    return relayError("not_approver", `Only the approver (${APPROVER_ROLE}) may review or approve; got ${by}.`);
  }
  return null;
}
