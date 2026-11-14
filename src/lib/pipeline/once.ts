// "The same action twice" for the mutating actions: each helper makes a repeat (a double click, a
// second tab, a stale page) a no-op with a sentence that says so. Used by the server actions; the
// rules themselves (who may approve, the release rule) stay in the modules.
import { db } from "@/lib/db/client";
import { getWorkspacePack } from "@/lib/pack";
import { approveSnapshot, previewSnapshotPayload } from "@/lib/relay";
import { hashSnapshot } from "@/lib/relay/core/snapshot";
import { visibilityChangedSinceSnapshot } from "@/lib/tether/visibility";
import type { RoleKey } from "@/lib/types";
import { ACTION_LEASE_MS, exclusive } from "./guard";

/** What a refused repeat says. `what` starts the sentence: "This answer", "A re-test". */
export function busyMessage(what: string): string {
  return `${what} is already being saved from another tab or an earlier click. Nothing was done twice; reload to see the result.`;
}

// ---------------------------------------------------------------------------------------------
// Text fields

export const MAX_NOTE = 2000;
export const MAX_OWNER = 200;

/** A real calendar date written YYYY-MM-DD (2026-02-30 and 2026-13-01 are not). */
export function isRealDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** The message for a continuation-plan entry that cannot be saved, or null. Values are trimmed first. */
export function planProblem(owner: string, dueDate: string, riskNote: string): string | null {
  if (!owner.trim() || !dueDate.trim() || !riskNote.trim()) return "Owner, due date and risk note are all required.";
  if (owner.trim().length > MAX_OWNER) return `Keep the owner under ${MAX_OWNER} characters (a name, not a paragraph).`;
  if (riskNote.trim().length > MAX_NOTE) return `Keep the risk note under ${MAX_NOTE} characters.`;
  if (!isRealDate(dueDate)) return "Use a real date like 2026-11-30.";
  return null;
}

/** The message for a review note or edited statement that is too long, or null. */
export function reviewTextProblem(note: string, statement: string): string | null {
  if (note.length > MAX_NOTE) return `Keep the note under ${MAX_NOTE} characters.`;
  if (statement.length > MAX_NOTE) return `Keep the statement under ${MAX_NOTE} characters.`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Review a claim once

/**
 * A decision that is already in place: approving an approved claim, rejecting a rejected one
 * (a stale tab, or the second of two clicks). Returns the sentence to show, or null to go on.
 */
/** How long the second of two identical actions waits for the first before it is told to reload. */
export const REPEAT_WAIT_MS = 20_000;

export async function reviewAlreadyDone(ws: string, claimId: string, decision: string): Promise<string | null> {
  if (decision !== "approved" && decision !== "rejected") return null;
  const [row] = await db()`SELECT review FROM claims WHERE workspace_id = ${ws} AND id = ${claimId}`;
  if (!row || row.review !== decision) return null;
  return decision === "approved" ? "Already approved. Nothing changed." : "Already rejected. Nothing changed.";
}

/**
 * A successor finding's claim is decided through the findings flow (First weeks: its own status,
 * rules, re-test and snapshot), never through a plain review decision. Returns the refusal for
 * such a claim, or null. The Review page does not list these claims; this stops a stale tab.
 */
export async function findingClaimProblem(ws: string, claimId: string): Promise<string | null> {
  const [row] = await db()`SELECT origin FROM claims WHERE workspace_id = ${ws} AND id = ${claimId}`;
  if (!row || row.origin !== "successor_finding") return null;
  return "This is a successor finding. Decide it on the First weeks page, where it is re-tested and released with the next snapshot.";
}

// ---------------------------------------------------------------------------------------------
// Approve a snapshot once

export type SnapshotOnce =
  | (Awaited<ReturnType<typeof approveSnapshot>> & { unchanged?: undefined })
  | { ok: true; unchanged: { version: number; hash: string } };

/**
 * approveSnapshot, but a repeat does not mint a second version of the same thing:
 *   * two approvals at once (two tabs, a double click): one runs; the other waits for it and
 *     then gets the "nothing changed" reply below (or, if the wait runs out, is told to reload);
 *   * nothing changed since the latest snapshot (same claims, plan and scores, so the same
 *     SHA-256, and no visibility change since it was approved): no new version, and the reply
 *     names the version that already covers it.
 * The first approval, and any approval after a real change, goes through as before.
 */
export async function approveSnapshotOnce(ws: string, actor: RoleKey): Promise<SnapshotOnce> {
  const busy: SnapshotOnce = { ok: false, code: "busy", error: busyMessage("This snapshot") };
  return exclusive<SnapshotOnce>(ws, "approve_snapshot", async () => {
    const [latest] = await db()`
      SELECT version, hash FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC LIMIT 1`;
    // Anyone but the approver gets the module's own refusal, never "already covered".
    if (latest && actor === (await getWorkspacePack(ws)).approverRole) {
      // The version number is part of the hashed payload: hash today's state as the latest version.
      const same = hashSnapshot(await previewSnapshotPayload(ws, Number(latest.version))) === String(latest.hash);
      // Who may see a message can change without changing a word of the payload (a limit or a widen
      // of a message no approved claim cites). The Handover page then says "Visibility changed after
      // this snapshot was approved" until a newer snapshot exists: so that approval must be allowed
      // to make one, or the notice could never clear.
      if (same && !(await visibilityChangedSinceSnapshot(ws))) {
        return { ok: true, unchanged: { version: Number(latest.version), hash: String(latest.hash) } };
      }
    }
    return approveSnapshot(ws, actor);
  }, busy, ACTION_LEASE_MS, 20_000);
}
