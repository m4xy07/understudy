"use server";
// Probe actions: the approver runs the probes again, with the model judge.
// The judge is given a time box: answers already in the cache come back at once, new ones are
// asked until the box is used up. A second click picks up where the first stopped, so the action
// is safe to repeat and never runs past the page's time limit.
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { modelAvailable } from "@/lib/model/client";
import { getWorkspacePack, roleLabel } from "@/lib/pack";
import { runProbes } from "@/lib/relay";
import { modelJudgeCall } from "@/lib/relay/probes";
import { viewingRole } from "@/lib/session";

export interface ActionState {
  ok: boolean;
  message: string | null;
}

const TIME_BOX_MS = 40_000;

export async function runProbesAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const ws = String(form.get("ws") ?? "");
  if (!isUuid(ws) || !(await getWorkspace(ws))) return { ok: false, message: "Workspace not found." };
  const pack = await getWorkspacePack(ws);
  const role = await viewingRole(ws);
  if (role !== pack.approverRole) {
    return { ok: false, message: `Only the approver (${roleLabel(pack.approverRole, pack)}) can run the probes.` };
  }
  const up = await modelAvailable();
  const deadline = Date.now() + TIME_BOX_MS;
  const call = modelJudgeCall({
    cacheOnly: () => !up || deadline - Date.now() < 3_000,
    timeoutMs: () => Math.max(3_000, deadline - Date.now()),
    retries: 0,
  });
  try {
    const { run } = await runProbes(ws, role, { call });
    refresh();
    const s = run.summary;
    const read = s.judgeCalls - s.judgeFailed;
    const judge = s.judgeCalls === 0
      ? "There was nothing for the model judge to read."
      : read === s.judgeCalls
        ? `The model judge read all ${s.judgeCalls} texts.`
        : read === 0
          ? "The model judge could not be asked this time. The key-term check still ran."
          : `The model judge read ${read} of ${s.judgeCalls} texts. Run again to finish the rest.`;
    return {
      ok: s.failed === 0,
      message: `${s.failed === 0 ? `All ${s.checks} checks pass.` : `${s.failed} of ${s.checks} checks fail.`} ${judge}`,
    };
  } catch (err) {
    return { ok: false, message: `The probes could not run: ${err instanceof Error ? err.message : String(err)}` };
  }
}
