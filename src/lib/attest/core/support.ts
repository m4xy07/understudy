// Attest support check: the model reads each claim's cited segment with its thread context and
// says whether it supports the statement (yes / partly / no). Code applies the verdict and can only
// LOWER trust, never raise it. Contract: docs/ARCHITECTURE.md section 4 "Claims (Attest)".
//
// Compartments: one model call only ever sees segments with one identical role set, the same rule
// as extraction. Context segments from the thread are shown only when their role set matches.
import { z, type ZodType } from "zod";
import type { Claim, Segment, Trust } from "@/lib/types";
import { trustRank } from "@/lib/trust";

/** Injected model call (same shape as the extraction builder's). */
export type ModelCall = <T>(opts: {
  system: string;
  user: string;
  schema: ZodType<T>;
  jsonSchemaName: string;
}) => Promise<{ ok: true; data: T; cached: boolean } | { ok: false; error: string }>;

export const supportVerdictSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["yes", "partly", "no"]),
    }),
  ),
});
export type SupportVerdicts = z.infer<typeof supportVerdictSchema>;

export interface SupportFailure {
  claimIds: string[];
  error: string;
}

export interface SupportResult {
  claims: Claim[];                                  // same order as input; unchecked claims unchanged
  checked: string[];                                // claim ids that got a verdict
  downgraded: string[];                             // claim ids whose trust was lowered
  skipped: { claimId: string; reason: string }[];
  failures: SupportFailure[];                       // model errors / missing verdicts: claims unchanged
  calls: number;
  cachedCalls: number;
}

export interface SupportOptions {
  batchSize?: number;     // claims per model call, default 20
  contextBefore?: number; // thread segments shown before the cited one, default 2
  contextAfter?: number;  // and after, default 1
}

/** The weaker of two trust levels (order: src/lib/trust.ts). */
export function weakerTrust(a: Trust, b: Trust): Trust {
  return trustRank(a) >= trustRank(b) ? a : b;
}

export const SUPPORT_SYSTEM = [
  "You check claims against their evidence.",
  "For each claim you get a statement and the cited segment (a message, task, note or file part),",
  "with nearby segments from the same thread for context. Decide whether the cited segment supports the statement.",
  "- yes: the cited segment says it, directly or as an obvious paraphrase.",
  "- partly: it supports some of the statement, or only with an extra assumption.",
  "- no: it does not say this, or says the opposite. Watch for not, never, no longer, cancelled, moved.",
  "Judge only from the text shown. Context helps you read the cited segment; it is not evidence by itself.",
  'Return JSON only: {"results":[{"id":"c1","verdict":"yes"}]} with one entry per claim id.',
].join("\n");

const roleKey = (s: Segment) => [...s.roleSet].sort().join(",");

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + " ...";
}

function threadIndex(segmentsById: Map<string, Segment>): Map<string, Segment[]> {
  const idx = new Map<string, Segment[]>();
  for (const s of segmentsById.values()) {
    const key = `${s.sourceId}\u0000${s.thread}`;
    const list = idx.get(key);
    if (list) list.push(s);
    else idx.set(key, [s]);
  }
  for (const list of idx.values()) {
    list.sort((a, b) => a.ts.localeCompare(b.ts) || a.position - b.position || (a.id < b.id ? -1 : 1));
  }
  return idx;
}

function renderEvidence(seg: Segment, threads: Map<string, Segment[]>, before: number, after: number): string {
  const list = threads.get(`${seg.sourceId}\u0000${seg.thread}`) ?? [seg];
  const i = list.findIndex((s) => s.id === seg.id);
  const same = (s: Segment) => roleKey(s) === roleKey(seg);
  const prev = list.slice(Math.max(0, i - before), Math.max(0, i)).filter(same);
  const next = list.slice(i + 1, i + 1 + after).filter(same);
  const line = (s: Segment) => `  [${s.ts.slice(0, 16)}] ${clip(s.text.replace(/\s+/g, " "), 300)}`;
  const parts = [`Thread: ${seg.thread} (${seg.sourceKind})`];
  if (prev.length) parts.push("Context before:", ...prev.map(line));
  parts.push(`CITED [${seg.ts.slice(0, 16)}]: ${clip(seg.text, 1500)}`);
  if (next.length) parts.push("Context after:", ...next.map(line));
  return parts.join("\n");
}

/**
 * Ask the model whether each claim's cited segment supports its statement, batched up to 20
 * claims per call and never mixing role sets in one call. Verdicts:
 * - no: trust lowered to inferred (or kept if already weaker), supportCheck "no";
 * - partly: trust unchanged, supportCheck "partly";
 * - yes: trust unchanged, supportCheck "yes".
 * Failures leave claims unchanged and are reported. Structured claims (no model reading) and
 * leaver answers are skipped.
 */
export async function supportCheck(
  claims: Claim[],
  segmentsById: Map<string, Segment>,
  call: ModelCall,
  opts: SupportOptions = {},
): Promise<SupportResult> {
  const batchSize = Math.max(1, opts.batchSize ?? 20);
  const before = opts.contextBefore ?? 2;
  const after = opts.contextAfter ?? 1;
  const threads = threadIndex(segmentsById);

  const out = claims.map((c) => ({ ...c }));
  const result: SupportResult = { claims: out, checked: [], downgraded: [], skipped: [], failures: [], calls: 0, cachedCalls: 0 };

  // Pick the evidence segment per claim and group claims by the role set of what the model sees.
  const groups = new Map<string, { claim: Claim; segs: Segment[] }[]>();
  for (const claim of out) {
    if (claim.state === "dropped") { result.skipped.push({ claimId: claim.id, reason: "dropped" }); continue; }
    if (claim.origin !== "extracted") { result.skipped.push({ claimId: claim.id, reason: `origin ${claim.origin}` }); continue; }
    const accepted = claim.citations.filter((c) => c.accepted);
    // Exact citations first: they are what the claim's trust rests on.
    accepted.sort((a, b) => Number(b.exact) - Number(a.exact));
    const segs: Segment[] = [];
    for (const c of accepted) {
      const s = segmentsById.get(c.segmentId);
      if (s && !segs.some((x) => x.id === s.id)) segs.push(s);
    }
    if (segs.length === 0) { result.skipped.push({ claimId: claim.id, reason: "no accepted citation" }); continue; }
    const keys = new Set(segs.map(roleKey));
    if (keys.size > 1) { result.skipped.push({ claimId: claim.id, reason: "cited segments have different role sets" }); continue; }
    const key = [...keys][0];
    const g = groups.get(key);
    const item = { claim, segs: segs.slice(0, 3) };
    if (g) g.push(item);
    else groups.set(key, [item]);
  }

  for (const items of groups.values()) {
    for (let start = 0; start < items.length; start += batchSize) {
      const batch = items.slice(start, start + batchSize);
      const local = new Map<string, Claim>();
      const blocks = batch.map((item, k) => {
        const id = `c${k + 1}`;
        local.set(id, item.claim);
        const evidence = item.segs.map((s) => renderEvidence(s, threads, before, after)).join("\n");
        return `### ${id}\nStatement: ${item.claim.statement}\n${evidence}`;
      });
      const user = `Check these ${batch.length} claims.\n\n${blocks.join("\n\n")}\n\n/no_think`;
      const ids = batch.map((b) => b.claim.id);

      let res: Awaited<ReturnType<ModelCall>>;
      try {
        res = await call({ system: SUPPORT_SYSTEM, user, schema: supportVerdictSchema, jsonSchemaName: "support_check" });
      } catch (e) {
        res = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      result.calls++;
      if (!res.ok) {
        result.failures.push({ claimIds: ids, error: res.error });
        continue;
      }
      if (res.cached) result.cachedCalls++;

      const seen = new Set<string>();
      for (const r of (res.data as SupportVerdicts).results) {
        const claim = local.get(r.id);
        if (!claim || seen.has(r.id)) continue;
        seen.add(r.id);
        claim.supportCheck = r.verdict;
        if (r.verdict === "no") {
          const lowered = weakerTrust(claim.trust, "inferred");
          if (lowered !== claim.trust) {
            claim.trust = lowered;
            result.downgraded.push(claim.id);
          }
        }
        result.checked.push(claim.id);
      }
      const missing = [...local.entries()].filter(([id]) => !seen.has(id)).map(([, c]) => c.id);
      if (missing.length) result.failures.push({ claimIds: missing, error: "no verdict returned" });
    }
  }

  return result;
}
