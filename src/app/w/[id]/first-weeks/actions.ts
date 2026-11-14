"use server";
// First weeks actions (living handover). The role always comes from the cookie on the server.
// Every rule (only the successor records, only the approver decides, the leaver never, masking,
// narrowing, the tier C evidence and reason, the release rule) is enforced in src/lib/relay/living.
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { viewingRole } from "@/lib/session";
import { getWorkspacePack, isRoleOf, roleLabel } from "@/lib/pack";
import { FILE_MAX_BYTES, FINDING_ERRORS } from "@/lib/relay/core/finding";
import { decideFinding, recordFinding, withdrawFinding } from "@/lib/relay/living";
import type { ActionState } from "@/components/ActionForm";
import type { RoleKey } from "@/lib/types";

const fail = (message: string): ActionState => ({ ok: false, message });
const done = (message: string | null = null): ActionState => ({ ok: true, message });

async function workspaceFrom(form: FormData): Promise<string | null> {
  const ws = String(form.get("ws") ?? "");
  if (!isUuid(ws)) return null;
  return (await getWorkspace(ws)) ? ws : null;
}

/** The successor records a finding. It waits for the approver; scores do not change. */
export async function recordFindingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const role = await viewingRole(ws);
  const pack = await getWorkspacePack(ws);

  let attachment: { name: string; bytes: Uint8Array } | null = null;
  const file = form.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > FILE_MAX_BYTES) return fail(FINDING_ERRORS.fileTooLarge);
    attachment = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  const narrowRoles = form.get("narrow") === "1"
    ? form.getAll("roles").map(String).filter((r): r is RoleKey => isRoleOf(pack, r))
    : null;
  const res = await recordFinding(ws, role, {
    responsibilityId: String(form.get("responsibilityId") ?? ""),
    checkKey: String(form.get("checkKey") ?? ""),
    answer: String(form.get("answer") ?? ""),
    note: String(form.get("note") ?? ""),
    link: String(form.get("link") ?? ""),
    attachment,
    narrowRoles,
    example: form.get("example") === "1",
  });
  if (!res.ok) return fail(res.error);
  refresh();
  return done(`Saved as "Successor found". It is waiting for ${roleLabel(pack.approverRole, pack)} to review. Scores do not change until it is approved.`);
}

export async function withdrawFindingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const res = await withdrawFinding(ws, await viewingRole(ws), String(form.get("findingId") ?? ""));
  if (!res.ok) return fail(res.error);
  refresh();
  return done("Finding withdrawn.");
}

/** The approver approves (re-test, next snapshot) or rejects a finding. */
export async function decideFindingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const decision = String(form.get("decision") ?? "");
  if (decision !== "approved" && decision !== "rejected") return fail("Unknown decision.");
  const res = await decideFinding(ws, await viewingRole(ws), String(form.get("findingId") ?? ""), decision, {
    note: String(form.get("note") ?? ""),
    evidenceOpened: form.get("evidenceOpened") === "true",
  });
  if (!res.ok) return fail(res.error);
  refresh();
  if (decision === "rejected") return done("Finding rejected. The gap stays open.");
  if (res.blocked) {
    return done(`Finding approved. Snapshot v${res.nextVersion ?? "next"} is not released yet: ${res.blocked} Fix the plan below, then approve the snapshot.`);
  }
  if (res.snapshot) return done(`Finding approved. Snapshot v${res.snapshot.version} released. ${res.delta ?? ""}`.trim());
  return done("Finding approved.");
}
