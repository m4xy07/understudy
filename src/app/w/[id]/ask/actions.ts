"use server";
// Ask page actions. The role always comes from the cookie on the server; only the leaver answers
// gap questions, only the approver switches recovery, and only the role that was asked answers a
// neighbour question (all enforced in src/lib/lacuna).
import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { viewingRole, roleCookieName } from "@/lib/session";
import { after } from "next/server";
import { getWorkspacePack, isRoleOf, roleLabel } from "@/lib/pack";
import {
  answerAsNeighbour, answerQuestion, askedRoles, buildLadder, declineAsNeighbour, recoveryState, setLeaverUnreachable,
} from "@/lib/lacuna";
import { runWithModelContext } from "@/lib/model/client";
import { exclusive, spendContext } from "@/lib/pipeline/guard";
import { busyMessage, REPEAT_WAIT_MS } from "@/lib/pipeline/once";
import { fastFirst, liveStandin, scheduleRejudge } from "@/lib/pipeline/rejudge";
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
  const questionId = String(form.get("questionId") ?? "");
  // The first result is the rule-based reading (milliseconds, cached model answers replay); the
  // live model then re-checks it in the background and the page updates by itself.
  const live = liveStandin();
  const save = () => answerQuestion(ws, questionId, String(form.get("answer") ?? ""), role, narrow);
  // One save per question at a time: a second click or a second tab cannot store two answers.
  // The second waits for the first and is then refused by the question's own state.
  const res = await exclusive(ws, `answer:${questionId}`, () => (live ? fastFirst(save) : save()),
    { ok: false as const, error: busyMessage("This answer") }, 120_000, REPEAT_WAIT_MS);
  if (!res.ok) {
    refresh(); // a refused repeat still brings the page up to date (the question may be answered now)
    return fail(res.error);
  }
  const recheck = live ? await scheduleRejudge(ws) : null;
  if (recheck) after(recheck);
  refresh();
  return {
    ok: true,
    message: `Saved as "Leaver said". Re-test: ${res.delta}${live ? " This is the first reading; the model is re-checking it now and the scores update by themselves." : ""}`,
  };
}

/** One recovery switch or ladder rebuild at a time per workspace. */
const RECOVERY_KEY = "recovery";

async function setRoleCookie(ws: string, role: RoleKey): Promise<void> {
  (await cookies()).set(roleCookieName(ws), role, { path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 7 });
}

/** "Switch to <the leaver> to answer": sets the viewing role cookie to the pack's leaver role. */
export async function switchToLeaverAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  await setRoleCookie(ws, (await getWorkspacePack(ws)).leaverRole);
  refresh();
  return { ok: true, message: null };
}

/**
 * "Switch to <a neighbour> to answer": sets the viewing role cookie to a role that has a question
 * waiting. Any other value is refused.
 */
export async function switchToRoleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const pack = await getWorkspacePack(ws);
  const role = String(form.get("role") ?? "");
  if (!isRoleOf(pack, role) || !(await askedRoles(ws)).includes(role)) return fail("No question is waiting for that role.");
  await setRoleCookie(ws, role);
  refresh();
  return { ok: true, message: null };
}

/** The approver marks the leaver as unreachable (on = "1") or reachable again (on = "0"). Audited. */
export async function setUnreachableAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const role = await viewingRole(ws);
  // One switch (or ladder rebuild) at a time per workspace: a double click or a second tab waits
  // for the first, then gets the module's own "already on / already off" reply. Live model calls
  // made while the ladder reads traces count against the workspace's budget.
  const res = await exclusive(ws, RECOVERY_KEY, () => runWithModelContext(spendContext(ws), () =>
    setLeaverUnreachable(ws, String(form.get("on") ?? "") === "1", role, String(form.get("note") ?? ""))),
    { ok: false as const, error: busyMessage("This change") }, 180_000, REPEAT_WAIT_MS);
  if (!res.ok) return fail(res.error);
  refresh();
  return { ok: true, message: res.message };
}

/** The approver rebuilds the ladder (after a pipeline re-run the gaps may have changed). */
export async function rebuildLadderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const pack = await getWorkspacePack(ws);
  if ((await viewingRole(ws)) !== pack.approverRole) return fail(`Only ${roleLabel(pack.approverRole, pack)} can change this.`);
  if (!(await recoveryState(ws)).on) return fail("Recovery is off.");
  const built = await exclusive(ws, RECOVERY_KEY, () => runWithModelContext(spendContext(ws), () => buildLadder(ws)),
    null, 180_000);
  if (!built) return fail(busyMessage("The ladder"));
  refresh();
  return { ok: true, message: `Ladder rebuilt for ${built.gaps} ${built.gaps === 1 ? "gap" : "gaps"}.` };
}

/** A neighbour answers. The answer is labelled Second-hand; the reply is the re-test sentence. */
export async function answerAsNeighbourAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const role = await viewingRole(ws);
  const pack = await getWorkspacePack(ws);
  const stepId = String(form.get("stepId") ?? "");
  const decline = String(form.get("intent") ?? "") === "decline";
  const picked = form.getAll("roles").map(String).filter((r): r is RoleKey => isRoleOf(pack, r));
  // One reply per asked step at a time: a second click or a second tab cannot store two answers.
  // The second waits for the first and is then refused by the step's own state. The re-test is
  // narrowed to the one responsibility, so it runs with the live model here (no background
  // re-check: the Second-hand sentence stored with the step is the model's reading); its calls
  // count against the workspace's budget.
  const res = await exclusive(ws, `neighbour:${stepId}`, () => (decline
    ? declineAsNeighbour(ws, stepId, role)
    : runWithModelContext(spendContext(ws), () =>
      answerAsNeighbour(ws, stepId, String(form.get("answer") ?? ""), role, { narrowRoles: picked }))),
    { ok: false as const, error: busyMessage(decline ? "This reply" : "This answer") }, 120_000, REPEAT_WAIT_MS);
  if (!res.ok) {
    refresh(); // a refused repeat still brings the page up to date
    return fail(res.error);
  }
  refresh();
  if (res.declined) return { ok: true, message: "Noted. Nothing was saved as evidence." };
  return { ok: true, message: `Saved as "Second-hand". Re-test: ${res.delta}` };
}
