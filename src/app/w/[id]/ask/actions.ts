"use server";
// Ask page actions. The role always comes from the cookie on the server; only the leaver answers
// (enforced in src/lib/lacuna).
import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { viewingRole, roleCookieName } from "@/lib/session";
import { getWorkspacePack, isRoleOf } from "@/lib/pack";
import { answerQuestion } from "@/lib/lacuna";
import type { RoleKey } from "@/lib/types";

export interface ActionState {
  ok: boolean;
  message: string | null;
}

const fail = (message: string): ActionState => ({ ok: false, message });

async function workspaceFrom(form: FormData): Promise<string | null> {
  const ws = String(form.get("ws") ?? "");
  if (!isUuid(ws)) return null;
  return (await getWorkspace(ws)) ? ws : null;
}

/** The leaver answers; the reply is the re-test sentence, e.g. "B 7 → 6: … · C 71% → 76% · K 100% → 94%". */
export async function answerQuestionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const role = await viewingRole(ws);
  const pack = await getWorkspacePack(ws);
  const base = pack.uploadDefaults.roleSet as RoleKey[];
  const picked = form.getAll("roles").map(String).filter((r): r is RoleKey => isRoleOf(pack, r));
  // All boxes ticked means "no narrowing"; fewer means narrow to those (never wider than the default).
  const narrow = picked.length > 0 && picked.length < base.length ? picked : undefined;
  const res = await answerQuestion(ws, String(form.get("questionId") ?? ""), String(form.get("answer") ?? ""), role, narrow);
  if (!res.ok) return fail(res.error);
  refresh();
  return { ok: true, message: `Saved as "Leaver said". Re-test: ${res.delta}` };
}

/** "Switch to <the leaver> to answer": sets the viewing role cookie to the pack's leaver role. */
export async function switchToLeaverAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  (await cookies()).set(roleCookieName(ws), (await getWorkspacePack(ws)).leaverRole, {
    path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 7,
  });
  refresh();
  return { ok: true, message: null };
}
