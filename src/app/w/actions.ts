"use server";
// Workspace actions. Every action re-reads the role from the cookie on the server and checks
// the workspace exists; permission rules live in the module functions (e.g. leaver never approves).
import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { viewingRole, roleCookieName } from "@/lib/session";
import { answerQuestion, buildQuestions, runTest, savePlanItem } from "@/lib/lacuna";
import { approveSnapshot, bulkApprove, reviewClaim } from "@/lib/relay";
import { getWorkspacePack, isRoleOf } from "@/lib/pack";
import type { RoleKey } from "@/lib/types";

export interface ActionState {
  ok: boolean;
  message: string | null;
}

const fail = (message: string): ActionState => ({ ok: false, message });
const done = (message: string | null = null): ActionState => ({ ok: true, message });

async function workspaceFrom(form: FormData): Promise<string | null> {
  const ws = String(form.get("ws") ?? "");
  if (!isUuid(ws)) return null;
  return (await getWorkspace(ws)) ? ws : null;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export async function setRole(ws: string, role: string): Promise<void> {
  if (!isUuid(ws) || !(await getWorkspace(ws))) return;
  // Only a role of this workspace's pack can be picked.
  if (!isRoleOf(await getWorkspacePack(ws), role)) return;
  (await cookies()).set(roleCookieName(ws), role, {
    path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 7,
  });
  refresh();
}

export async function answerAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const role = await viewingRole(ws);
  const pack = await getWorkspacePack(ws);
  const narrow = form.getAll("roles").map(String).filter((r): r is RoleKey => isRoleOf(pack, r));
  const res = await answerQuestion(ws, String(form.get("questionId") ?? ""), String(form.get("answer") ?? ""), role, narrow);
  if (!res.ok) return fail(res.error);
  refresh();
  const b = res.before;
  const a = res.after;
  return done(b
    ? `Saved as "Leaver said". Re-test: B ${b.b} → ${a.b} · C ${pct(b.c)} → ${pct(a.c)}.`
    : `Saved as "Leaver said". Re-test: B ${a.b} · C ${pct(a.c)}.`);
}

export async function reviewAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const role = await viewingRole(ws);
  const decision = String(form.get("decision") ?? "");
  if (decision !== "approved" && decision !== "rejected" && decision !== "edited") return fail("Unknown decision.");
  const res = await reviewClaim(ws, String(form.get("claimId") ?? ""), decision, role, {
    note: String(form.get("note") ?? ""),
    statement: String(form.get("statement") ?? ""),
  });
  if (!res.ok) return fail(res.error);
  refresh();
  return done(decision === "rejected" ? "Rejected." : "Approved.");
}

export async function bulkApproveAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const res = await bulkApprove(ws, await viewingRole(ws), ["A", "B"]);
  if (!res.ok) return fail(res.error);
  refresh();
  return done(`Approved ${res.approved ?? 0} claim(s) in tiers A and B. Tier C still needs one-by-one review.`);
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
  return done(`Snapshot v${s.version} approved. SHA-256 ${s.hash.slice(0, 16)}…`);
}

export async function rerunTestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const pack = await getWorkspacePack(ws);
  const t = await runTest(ws, pack.successorRole);
  for (const role of pack.testRoles) if (role !== pack.successorRole) await runTest(ws, role);
  await buildQuestions(ws);
  refresh();
  return done(`Re-tested: B ${t.scores.b} · C ${pct(t.scores.c)}.`);
}
