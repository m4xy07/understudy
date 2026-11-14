"use server";
// Handover actions (Relay): typed read-back and the append-only acknowledgement of receipt.
// The role comes from the cookie; expected values never come from the client.
import { refresh } from "next/cache";
import { getWorkspace } from "@/lib/db/queries";
import { isUuid } from "@/lib/db/withRole";
import { viewingRole } from "@/lib/session";
import { getWorkspacePack } from "@/lib/pack";
import { acknowledgeHandover, checkHandoverReadback } from "@/lib/relay";
import { exclusive } from "@/lib/pipeline/guard";
import { busyMessage } from "@/lib/pipeline/once";
import type { ReadbackState } from "./ReadbackForm";

export async function readbackAction(_prev: ReadbackState, form: FormData): Promise<ReadbackState> {
  const ws = String(form.get("ws") ?? "");
  if (!isUuid(ws) || !(await getWorkspace(ws))) return { ok: false, message: "Workspace not found.", verdicts: null, acked: false };
  const role = await viewingRole(ws);
  const typed: Record<string, string> = {};
  for (const item of (await getWorkspacePack(ws)).readback) typed[item.key] = String(form.get(`rb_${item.key}`) ?? "");

  if (form.get("intent") === "ack") {
    const res = await exclusive(ws, `ack:${role}`, () => acknowledgeHandover(ws, role, typed),
      { ok: false as const, error: busyMessage("This acknowledgement") }, 30_000);
    if (!res.ok) return { ok: false, message: res.error, verdicts: null, acked: false };
    refresh();
    const visible = res.ack.verdicts.filter((v) => v.verdict !== "not_visible");
    const matched = visible.filter((v) => v.verdict === "match").length;
    return {
      ok: true,
      message: res.ack.allMatched
        ? `Receipt acknowledged. All ${visible.length} items matched the snapshot.`
        : `Receipt acknowledged with ${matched} of ${visible.length} items matching. The mismatches are on record.`,
      verdicts: res.ack.verdicts,
      acked: true,
    };
  }

  const res = await checkHandoverReadback(ws, role, typed);
  if (!res.ok) return { ok: false, message: res.error, verdicts: null, acked: false };
  const visible = res.verdicts.filter((v) => v.verdict !== "not_visible");
  const matched = visible.filter((v) => v.verdict === "match").length;
  return {
    ok: true,
    message: visible.length ? `${matched} of ${visible.length} items match the snapshot.` : "Nothing to check for this role.",
    verdicts: res.verdicts,
    acked: false,
  };
}
