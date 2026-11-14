"use server";
// Landing actions: create a private workspace and send the visitor to Connect.
import { after } from "next/server";
import { redirect } from "next/navigation";
import { createDemoWorkspace, createEmptyWorkspace } from "@/lib/pipeline/ingest";
import { listDemoPacks } from "@/lib/pack";
import { executeRun, startRun } from "@/lib/pipeline/run";

/** Open a private copy of a pack's demo. `packId` must be one of the demos in packs/index.json. */
export async function openDemo(packId: string): Promise<{ error: string } | void> {
  let id: string;
  try {
    if (!listDemoPacks().some((p) => p.id === packId)) return { error: "That demo is not available." };
    id = (await createDemoWorkspace(packId)).id;
    const { runId } = await startRun(id);
    after(async () => {
      await executeRun(id, runId);
    });
  } catch (err) {
    console.error("openDemo failed", err);
    return { error: `Could not create the demo workspace: ${err instanceof Error ? err.message : String(err)}` };
  }
  redirect(`/w/${id}/connect`);
}

export async function startEmpty(): Promise<{ error: string } | void> {
  let id: string;
  try {
    id = await createEmptyWorkspace();
  } catch (err) {
    console.error("startEmpty failed", err);
    return { error: `Could not create a workspace: ${err instanceof Error ? err.message : String(err)}` };
  }
  redirect(`/w/${id}/connect`);
}
