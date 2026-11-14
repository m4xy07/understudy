"use server";
// Review actions (Relay). The role always comes from the cookie on the server; every rule
// (approver only, leaver never, tier C evidence + reason, release rule) is enforced in src/lib/relay.
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { viewingRole } from "@/lib/session";
import { getWorkspacePack } from "@/lib/pack";
import { runTest, savePlanItem } from "@/lib/lacuna";
import { bulkApprove, reviewClaim } from "@/lib/relay";
import { exclusive } from "@/lib/pipeline/guard";
import { approveSnapshotOnce, busyMessage, planProblem, REPEAT_WAIT_MS, reviewAlreadyDone, reviewTextProblem } from "@/lib/pipeline/once";
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
  const [note, statement] = [String(form.get("note") ?? ""), String(form.get("statement") ?? "")];
  const tooLong = reviewTextProblem(note, statement);
  if (tooLong) return fail(tooLong);
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
  if (decision === "edited") {
    // Any edit triggers a re-test (scores stay provisional until the snapshot is approved).
    try {
      await runTest(ws, (await getWorkspacePack(ws)).successorRole);
    } catch {
      // The edit is saved; the next run of the test picks it up.
    }
  }
  refresh();
  return done(decision === "rejected" ? "Rejected." : decision === "edited" ? "Edit saved (labelled “edited by reviewer”)." : "Approved.");
}

export async function bulkApproveAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const res = await bulkApprove(ws, await viewingRole(ws));
  if (!res.ok) return fail(res.error);
  refresh();
  return done(`Approved ${res.approved ?? 0} tier A claim${res.approved === 1 ? "" : "s"}.`);
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
