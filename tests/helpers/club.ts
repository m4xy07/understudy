// The club pack's role facts for tests, read from packs/club.json (never retyped here).
// Core functions take these as arguments; tests that call a changed signature pass them.
// Tests may keep club literals (role keys in fixtures); only core code is checked for them.
import { approvalRoles, getPack, roleLabel } from "@/lib/pack";
import type { ApprovalRoles } from "@/lib/relay/core/labels";
import type { RoleKey } from "@/lib/types";

export const CLUB_ID = "club";
export const CLUB = getPack(CLUB_ID);

/** { approver, leaver, approverLabel } for applyReview, bulkApproveTierA, approveSnapshot, checkApprover. */
export const CLUB_ROLES: ApprovalRoles = approvalRoles(CLUB);

/** Roles the club flags as restricted audience ("sees least"): a claim hidden from one is tier C. */
export const CLUB_RESTRICTED: RoleKey[] = CLUB.restrictedAudienceRoles;

/** Canonical order of a role set for the club. */
export const CLUB_ROLE_ORDER: RoleKey[] = CLUB.roleOrder;

export const CLUB_APPROVER_LABEL = roleLabel(CLUB.approverRole, CLUB);
export const CLUB_LEAVER: RoleKey = CLUB.leaverRole;
export const CLUB_DEMO_DIR = CLUB.demo!.dataDir;
