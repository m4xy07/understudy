"use server";
// Connect actions: the approver widens or limits who sees one message.
// The role always comes from the cookie on the server; every rule (approver only, a written
// reason, never beyond the source's roles) is checked in src/lib/tether/visibility.ts.
import { refresh } from "next/cache";
import { after } from "next/server";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { executeRun } from "@/lib/pipeline/run";
import { viewingRole } from "@/lib/session";
import { CATEGORIES } from "@/lib/tether/sensitivity";
import { setSegmentVisibility, visibilityMessage } from "@/lib/tether/visibility";
import type { RoleKey, SensitivityCategory } from "@/lib/types";

export interface ActionState {
  ok: boolean;
  message: string | null;
}

const fail = (message: string): ActionState => ({ ok: false, message });
const done = (message: string): ActionState => ({ ok: true, message });

async function workspaceFrom(form: FormData): Promise<string | null> {
  const ws = String(form.get("ws") ?? "");
  if (!isUuid(ws)) return null;
  return (await getWorkspace(ws)) ? ws : null;
}

function rerun(ws: string, runId: string | null): void {
  if (!runId) return;
  after(async () => {
    await executeRun(ws, runId);
  });
}

/** Widen one limited message, to every role of its source or to chosen roles. */
export async function widenAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const segmentId = String(form.get("segment") ?? "");
  const mode = String(form.get("mode") ?? "source");
  // Roles that already see the message are ticked and locked in the form: they always stay.
  const keep = form.getAll("keep").map(String);
  const chosen = [...new Set([...keep, ...form.getAll("roles").map(String)])] as RoleKey[];
  const res = await setSegmentVisibility(
    ws, segmentId,
    { action: "widen", roles: mode === "choose" ? chosen : "source", reason: String(form.get("reason") ?? "") },
    await viewingRole(ws),
  );
  if (!res.ok) return fail(res.error);
  rerun(ws, res.runId);
  refresh();
  return done(visibilityMessage("Widened", res));
}

/** Limit one message to the roles allowed for the chosen kind of content. Takes effect at once. */
export async function limitAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = await workspaceFrom(form);
  if (!ws) return fail("Workspace not found.");
  const segmentId = String(form.get("segment") ?? "");
  const picked = form.getAll("category").map(String);
  const categories = CATEGORIES.filter((c) => picked.includes(c)) as SensitivityCategory[];
  const res = await setSegmentVisibility(
    ws, segmentId,
    { action: "limit", categories, reason: String(form.get("reason") ?? "") },
    await viewingRole(ws),
  );
  if (!res.ok) return fail(res.error);
  rerun(ws, res.runId);
  refresh();
  return done(visibilityMessage("Limited", res));
}
