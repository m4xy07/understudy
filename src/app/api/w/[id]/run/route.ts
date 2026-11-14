// GET: latest pipeline run status (polled every 1.5 s), plus whether background work (the model
// re-check after an answer) is still going. POST: start a run, or continue the live one, in the
// background. Two POSTs can never start two runs: the second attaches to the first (run lease).
import { after } from "next/server";
import { getRunStatus, getWorkspace } from "@/lib/db/queries";
import { executeRun, startRun } from "@/lib/pipeline/run";
import { leaseHeld } from "@/lib/pipeline/guard";
import { REJUDGE_KEY } from "@/lib/pipeline/rejudge";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const noStore = { "cache-control": "no-store" };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    if (!(await getWorkspace(id))) return Response.json({ error: "Workspace not found." }, { status: 404, headers: noStore });
    const [run, background] = await Promise.all([getRunStatus(id), leaseHeld(id, REJUDGE_KEY).catch(() => false)]);
    return Response.json({ run, background }, { headers: noStore });
  } catch (err) {
    console.error(`[run ${id}] status failed`, err);
    return Response.json({ error: "The server could not read the run status. It will retry." }, { status: 503, headers: noStore });
  }
}

export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    if (!(await getWorkspace(id))) return Response.json({ error: "Workspace not found." }, { status: 404, headers: noStore });
    const { runId, alreadyRunning, resumed } = await startRun(id);
    if (!alreadyRunning) {
      after(async () => {
        await executeRun(id, runId);
      });
    }
    return Response.json({ runId, alreadyRunning, resumed }, { status: 202, headers: noStore });
  } catch (err) {
    console.error(`[run ${id}] start failed`, err);
    return Response.json({ error: "The run could not be started. Wait a moment and press Run again." }, { status: 503, headers: noStore });
  }
}
