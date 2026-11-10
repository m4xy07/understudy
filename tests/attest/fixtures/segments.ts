// Test fixtures for Attest extraction: segment factory, a small mixed dataset and a fake ModelCall.
import type { RoleKey, Segment } from "@/lib/types";
import type { ExtractionPack, ModelCall } from "@/lib/attest/core/schema";
import packJson from "./pack.json";

export const pack: ExtractionPack = packJson;

export const ALL: RoleKey[] = ["president", "tech_lead", "new_member", "treasurer", "leaver"];
export const CORE: RoleKey[] = ["president", "tech_lead", "leaver"];

let auto = 0;
export function seg(p: Partial<Segment> & { text: string }): Segment {
  auto++;
  return {
    id: p.id ?? `seg_${String(auto).padStart(16, "0")}`,
    sourceId: p.sourceId ?? "src_slack",
    sourceKind: p.sourceKind ?? "slack",
    kind: p.kind ?? "message",
    ts: p.ts ?? new Date(Date.UTC(2026, 7, 1, 9, 0, auto)).toISOString(),
    authorId: p.authorId === undefined ? "p-1" : p.authorId,
    thread: p.thread ?? "#firmware",
    position: p.position ?? auto,
    text: p.text,
    textHash: p.textHash ?? "0".repeat(64),
    roleSet: p.roleSet ?? ALL,
    version: p.version ?? 1,
    meta: p.meta ?? {},
  };
}

export function at(day: number, minute = 0): string {
  return new Date(Date.UTC(2026, 7, day, 9, minute)).toISOString();
}

/** Segment ids that appear as headers in a rendered user prompt. */
export function promptSegmentIds(user: string): string[] {
  return [...user.matchAll(/^\[(seg_[^\]]+)\]/gm)].map((m) => m[1]);
}

export type Responder = (opts: { system: string; user: string; ids: string[] }) =>
  | unknown
  | Error
  | { fail: string };

/** A fake model: canned JSON per call, parsed with the caller's schema like the real client. */
export function fakeModel(respond: Responder, opts: { cached?: boolean; delayMs?: number } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: Parameters<ModelCall>[0][] = [];
  const call: ModelCall = async (o) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(o);
    try {
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 3));
      const raw = respond({ system: o.system, user: o.user, ids: promptSegmentIds(o.user) });
      if (raw instanceof Error) throw raw;
      if (raw && typeof raw === "object" && "fail" in raw) return { ok: false, error: String(raw.fail) };
      const json = typeof raw === "string" ? JSON.parse(raw) : raw;
      const parsed = o.schema.safeParse(json);
      if (!parsed.success) return { ok: false, error: "invalid JSON from model" };
      return { ok: true, data: parsed.data, cached: opts.cached ?? false };
    } finally {
      inFlight--;
    }
  };
  return { call, calls, maxInFlight: () => maxInFlight };
}
