"use server";
// Review actions (Relay). The role always comes from the cookie on the server; every rule
// (approver only, leaver never, tier C evidence + reason, release rule) is enforced in src/lib/relay.
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { viewingRole } from "@/lib/session";
import { getWorkspacePack } from "@/lib/pack";
import { runTest, savePlanItem } from "@/lib/lacuna";
import { approveSnapshot, bulkApprove, reviewClaim } from "@/lib/relay";
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
  const res = await reviewClaim(ws, String(form.get("claimId") ?? ""), decision, role, {
    note: String(form.get("note") ?? ""),
    statement: String(form.get("statement") ?? ""),
    evidenceOpened: form.get("evidenceOpened") === "true",
  });
  if (!res.ok) return fail(res.error);
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
  if (!owner || !dueDate || !riskNote) return fail("Owner, due date and risk note are all required.");
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
  const res = await approveSnapshot(ws, await viewingRole(ws));
  if (!res.ok) return fail(res.error);
  refresh();
  const s = res.snapshot!;
  return done(`Snapshot v${s.version} approved · SHA-256 ${s.hash.slice(0, 12)}… · ${res.label}.`);
}
