"use server";
// Review actions (Relay). The role always comes from the cookie on the server; every rule
// (approver only, leaver never, tier C evidence + reason, release rule) is enforced in src/lib/relay.
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { viewingRole } from "@/lib/session";
import { savePlanItem } from "@/lib/lacuna";
import { approveGroup, bulkApprove, reviewClaim } from "@/lib/relay";
import { exclusive, isSafeId } from "@/lib/pipeline/guard";
import {
  approveSnapshotOnce, busyMessage, findingClaimProblem, planProblem, REPEAT_WAIT_MS, reviewAlreadyDone, reviewTextProblem,
} from "@/lib/pipeline/once";
import { evidenceChanged } from "@/lib/pipeline/rejudge";
import { retestAfterReview, retestResponsibilities, SAVED_NOT_RETESTED } from "@/lib/pipeline/retest";
import type { ActionState } from "@/components/ActionForm";

const fail = (message: string): ActionState => ({ ok: false, message });
const done = (message: string | null = null): ActionState => ({ ok: true, message });

async function workspaceFrom(form: FormData): Promise<string | null> {
  const ws = String(form.get("ws") ?? "");
  if (!isUuid(ws)) return null;
  return (await getWorkspace(ws)) ? ws : null;
}

export async function reviewClaimAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const role = await viewingRole(ws);
  const decision = String(form.get("decision") ?? "");
  if (decision !== "approved" && decision !== "rejected" && decision !== "edited") return fail("Unknown decision.");
  const claimId = String(form.get("claimId") ?? "");
  if (!isSafeId(claimId)) return fail("Claim not found.");
  const [note, statement] = [String(form.get("note") ?? ""), String(form.get("statement") ?? "")];
  const tooLong = reviewTextProblem(note, statement);
  if (tooLong) return fail(tooLong);
  // A successor finding is decided on First weeks (its own status, re-test and snapshot). A stale
  // Review tab must not approve its claim behind that flow's back.
  const elsewhere = await findingClaimProblem(ws, claimId);
  if (elsewhere) return fail(elsewhere);
  // A repeat (second click, second tab, stale page) changes nothing and says so. The second of
  // two at once waits for the first, then sees its result.
  const res = await exclusive(ws, `review:${claimId}`, async () => {
    const already = await reviewAlreadyDone(ws, claimId, decision);
    if (already) return { ok: true as const, already };
    return reviewClaim(ws, claimId, decision, role, { note, statement, evidenceOpened: form.get("evidenceOpened") === "true" });
  }, { ok: false as const, error: busyMessage("This decision") }, 60_000, REPEAT_WAIT_MS);
  if (!res.ok) return fail(res.error);
  if ("already" in res) {
    refresh();
    return done(res.already);
  }
  // Every decision re-tests (scores stay provisional until the snapshot is approved): an approval
  // lets a Second-hand claim count on a blocking check, a rejection takes a claim's weight away,
  // an edit changes the text. Without it B stays stale and the snapshot releases on old numbers.
  await evidenceChanged(ws);
  const retested = await retestAfterReview(ws, claimId, `review ${decision}`);
  refresh();
  if (!retested) return done(SAVED_NOT_RETESTED);
  return done(decision === "rejected" ? "Rejected." : decision === "edited" ? "Edit saved (labelled “edited by reviewer”)." : "Approved.");
}

export async function bulkApproveAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const res = await bulkApprove(ws, await viewingRole(ws));
  if (!res.ok) return fail(res.error);
  await evidenceChanged(ws);
  refresh();
  return done(`Approved ${res.approved ?? 0} tier A claim${res.approved === 1 ? "" : "s"}.`);
}

/** Most claims one group approval may name (the form lists the claims that were on screen). */
const MAX_GROUP_IDS = 2000;

/**
 * Approve the pending tier B claims of one responsibility (or one topic outside every
 * responsibility) after its list was opened. One re-test for the whole group.
 */
export async function approveGroupAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const role = await viewingRole(ws);
  const group = String(form.get("group") ?? "");
  if (!/^(resp|topic):/.test(group) || !isSafeId(group)) return fail("Group not found. Reload the page.");
  const claimIds = String(form.get("claimIds") ?? "").split(",").filter(Boolean);
  if (claimIds.length === 0 || claimIds.length > MAX_GROUP_IDS || !claimIds.every(isSafeId)) return fail("Reload the page and open the list again.");
  // One approval per group at a time: a second click or tab waits, then finds nothing left to approve.
  const res = await exclusive(ws, `review-group:${group}`, () =>
    approveGroup(ws, role, group, { expanded: form.get("expanded") === "true", claimIds }),
  { ok: false as const, error: busyMessage("This approval") }, 60_000, REPEAT_WAIT_MS);
  if (!res.ok) return fail(res.error);
  const n = res.approved ?? 0;
  if (n === 0) {
    refresh();
    return done("Already approved. Nothing changed.");
  }
  await evidenceChanged(ws);
  const retested = await retestResponsibilities(ws, res.responsibilityId ? [res.responsibilityId] : [], "review group approved");
  refresh();
  if (!retested) return done(SAVED_NOT_RETESTED);
  return done(`Approved ${n} tier B claim${n === 1 ? "" : "s"}.`);
}

export async function savePlanAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const owner = String(form.get("owner") ?? "").trim();
  const dueDate = String(form.get("dueDate") ?? "").trim();
  const riskNote = String(form.get("riskNote") ?? "").trim();
  const bad = planProblem(owner, dueDate, riskNote);
  if (bad) return fail(bad);
  const res = await savePlanItem(ws, {
    responsibilityId: String(form.get("responsibilityId") ?? ""),
    checkKey: String(form.get("checkKey") ?? ""),
    owner, dueDate, riskNote,
  }, await viewingRole(ws));
  if (!res.ok) return fail(res.error);
  await evidenceChanged(ws);
  refresh();
  return done("Plan saved.");
}

export async function approveSnapshotAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const res = await approveSnapshotOnce(ws, await viewingRole(ws));
  if (!res.ok) return fail(res.error);
  refresh();
  if (res.unchanged) {
    return done(`Snapshot v${res.unchanged.version} already covers exactly this state (SHA-256 ${res.unchanged.hash.slice(0, 12)}…). No new version was created.`);
  }
  const s = res.snapshot!;
  return done(`Snapshot v${s.version} approved · SHA-256 ${s.hash.slice(0, 12)}… · ${res.label}.`);
}
