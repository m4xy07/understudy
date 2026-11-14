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
import { runWithModelContext } from "@/lib/model/client";
import { exclusive, spendContext } from "@/lib/pipeline/guard";
import { busyMessage, REPEAT_WAIT_MS } from "@/lib/pipeline/once";
import type { ActionState } from "@/components/ActionForm";
import type { RoleKey } from "@/lib/types";

const fail = (message: string): ActionState => ({ ok: false, message });
const done = (message: string | null = null): ActionState => ({ ok: true, message });

async function workspaceFrom(form: FormData): Promise<string | null> {
  const ws = String(form.get("ws") ?? "");
  if (!isUuid(ws)) return null;
  return (await getWorkspace(ws)) ? ws : null;
}

/** The lease approveSnapshotOnce holds (src/lib/pipeline/once.ts). */
const SNAPSHOT_KEY = "approve_snapshot";

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
  const responsibilityId = String(form.get("responsibilityId") ?? "");
  const checkKey = String(form.get("checkKey") ?? "");
  // One finding per gap at a time: the second of two clicks (or a second tab) waits for the first
  // and is then answered by the gap's own state (a finding is already waiting).
  const res = await exclusive(ws, `finding:${responsibilityId}:${checkKey}`, () => recordFinding(ws, role, {
    responsibilityId,
    checkKey,
    answer: String(form.get("answer") ?? ""),
    note: String(form.get("note") ?? ""),
    link: String(form.get("link") ?? ""),
    attachment,
    narrowRoles,
    example: form.get("example") === "1",
  }), { ok: false as const, error: busyMessage("This finding") }, 60_000, REPEAT_WAIT_MS);
  if (!res.ok) {
    refresh(); // a refused repeat still brings the page up to date
    return fail(res.error);
  }
  refresh();
  return done(`Saved as "Successor found". It is waiting for ${roleLabel(pack.approverRole, pack)} to review. Scores do not change until it is approved.`);
}

export async function withdrawFindingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const role = await viewingRole(ws);
  const findingId = String(form.get("findingId") ?? "");
  // Withdrawing and deciding the same finding never overlap (same lease as the decision).
  const res = await exclusive(ws, `decide_finding:${findingId}`, () => withdrawFinding(ws, role, findingId),
    { ok: false as const, error: busyMessage("This finding") }, 60_000, REPEAT_WAIT_MS);
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
  const role = await viewingRole(ws);
  const findingId = String(form.get("findingId") ?? "");
  const decide = () => runWithModelContext(spendContext(ws), () => decideFinding(ws, role, findingId, decision, {
    note: String(form.get("note") ?? ""),
    evidenceOpened: form.get("evidenceOpened") === "true",
  }));
  const busy = { ok: false as const, error: busyMessage("This decision") };
  // One decision per finding at a time, across tabs and server instances (the module also queues
  // repeats inside one instance); the second waits for the first and gets what the first did.
  // An approval can release the next snapshot, so it also holds the snapshot lease: it can never
  // mint a version at the same moment as the Review page's "Approve snapshot".
  const res = await exclusive(ws, `decide_finding:${findingId}`, () => (decision === "approved"
    ? exclusive(ws, SNAPSHOT_KEY, decide, busy, 120_000, REPEAT_WAIT_MS)
    : decide()), busy, 120_000, REPEAT_WAIT_MS);
  if (!res.ok) {
    refresh();
    return fail(res.error);
  }
  refresh();
  if (decision === "rejected") return done("Finding rejected. The gap stays open.");
  if (res.blocked) {
    return done(`Finding approved. Snapshot v${res.nextVersion ?? "next"} is not released yet: ${res.blocked} Fix the plan below, then approve the snapshot.`);
  }
  if (res.snapshot) return done(`Finding approved. Snapshot v${res.snapshot.version} released. ${res.delta ?? ""}`.trim());
  return done("Finding approved.");
}
