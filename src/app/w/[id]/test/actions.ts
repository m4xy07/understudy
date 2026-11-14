"use server";
// Test page actions. The role always comes from the cookie on the server; permission rules live
// in src/lib/lacuna (only the approver confirms the inventory or saves plan items).
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { viewingRole } from "@/lib/session";
import { getWorkspacePack, isRoleOf } from "@/lib/pack";
import { buildQuestions, confirmInventory, runTest, savePlanItem } from "@/lib/lacuna";
import { runWithModelContext } from "@/lib/model/client";
import { ACTION_LEASE_MS, actionContext, exclusive } from "@/lib/pipeline/guard";
import { busyMessage, planProblem } from "@/lib/pipeline/once";
import { evidenceChanged } from "@/lib/pipeline/rejudge";
import { RETEST_KEY } from "@/lib/pipeline/retest";
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

function pct(x: number | null): string {
  return x === null ? "n/a" : `${Math.round(x * 100)}%`;
}

/** Re-run the stand-in for the role on screen (and the successor, whose run feeds the questions). */
export async function rerunTestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const pack = await getWorkspacePack(ws);
  const successor = pack.successorRole;
  const asked = String(form.get("target") ?? "");
  const target: RoleKey = isRoleOf(pack, asked) ? asked : successor;
  // One re-test at a time per workspace; live model calls count against the workspace's budget,
  // none starts after the action's time budget, and the lease outlives the action (maxDuration).
  return exclusive(ws, RETEST_KEY, () => runWithModelContext(actionContext(ws), async () => {
    try {
      const t = await runTest(ws, target, { trigger: "re-run" });
      if (target !== successor) await runTest(ws, successor, { trigger: "re-run" });
      await buildQuestions(ws);
      refresh();
      return done(`Re-tested: B ${t.scores.b} · C ${pct(t.scores.c)} · K ${pct(t.scores.k)}.`);
    } catch (err) {
      return fail(`The test could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }), fail(busyMessage("A re-test")), ACTION_LEASE_MS);
}

export async function confirmInventoryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const res = await confirmInventory(ws, await viewingRole(ws));
  if (!res.ok) return fail(res.error);
  refresh();
  return done(`Inventory confirmed (${res.count} responsibilities).`);
}

/** Continuation plan entry (owner, due date, risk note) for an open blocking gap. Approver only. */
export async function savePlanItemAction(_prev: ActionState, form: FormData): Promise<ActionState> {
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
