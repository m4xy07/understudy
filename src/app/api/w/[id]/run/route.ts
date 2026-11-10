// GET: latest pipeline run status (polled every 1.5 s). POST: start a run in the background.
import { after } from "next/server";
import { getRunStatus, getWorkspace } from "@/lib/db/queries";
import { executeRun, startRun } from "@/lib/pipeline/run";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!(await getWorkspace(id))) return Response.json({ error: "Workspace not found." }, { status: 404 });
  const run = await getRunStatus(id);
  return Response.json({ run }, { headers: { "cache-control": "no-store" } });
}

export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!(await getWorkspace(id))) return Response.json({ error: "Workspace not found." }, { status: 404 });
  const { runId, alreadyRunning } = await startRun(id);
  if (!alreadyRunning) {
    after(async () => {
      await executeRun(id, runId);
    });
  }
  return Response.json({ runId, alreadyRunning }, { status: 202 });
}
