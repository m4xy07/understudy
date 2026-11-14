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
    // One retry: a busy database can cancel the first attempt. A half-made copy is purged later.
    try {
      id = (await createDemoWorkspace(packId)).id;
    } catch (err) {
      console.error("openDemo: first attempt failed, retrying once", err);
      id = (await createDemoWorkspace(packId)).id;
    }
    const { runId } = await startRun(id);
    after(async () => {
      await executeRun(id, runId);
    });
  } catch (err) {
    console.error("openDemo failed", err);
    return { error: "The demo could not be opened just now because the server was busy. Press the button again." };
  }
  redirect(`/w/${id}/connect`);
}

export async function startEmpty(): Promise<{ error: string } | void> {
  let id: string;
  try {
    id = await createEmptyWorkspace();
  } catch (err) {
    console.error("startEmpty failed", err);
    return { error: "The workspace could not be created just now because the server was busy. Press the button again." };
  }
  redirect(`/w/${id}/connect`);
}
