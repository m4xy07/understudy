// The wider leak check: every role, every surface, exact tokens and reworded facts.
// Contract: docs/ARCHITECTURE.md section 4a, docs/round3/specs/02_confidentiality.md section 9.
//
//   runLeakCheck(ws)        the grid, live: token scan and key-term probes over what each role is
//                           shown now, plus the judge findings of the latest stored run
//   runProbes(ws, actor)    the same grid with the model judge, stored as one probe_runs row
//   latestProbeRun(ws)      the stored run, for the Probe results page
//
// The judge reads restricted facts next to one role's outputs, so its results go only to
// probe_runs (admin table). Pages show fact text and quotes to the approver only.
import { z } from "zod";
import { db } from "@/lib/db/client";
import { audit } from "@/lib/db/queries";
import { callJson, modelAvailable, modelTag, type CallResult } from "@/lib/model/client";
import { getWorkspacePack, roleLabel } from "@/lib/pack";
import type { RoleKey } from "@/lib/types";
import { scanForCanaries } from "./core/canary";
import {
  hiddenFacts, judgeChunks, mergeJudge, scanForFacts, type JudgeAnswer, type ProbeFact, type ProbeFinding,
} from "./core/probes";
import { canaryTokens, compileHandover, probeFacts } from "./handover";
import { collectSurfaces, LEAK_SURFACES, SURFACE_LABELS, parseStoredJson, type LeakSurface } from "./surfaces";

export { LEAK_SURFACES, SURFACE_LABELS, type LeakSurface } from "./surfaces";

export type LeakRow = "token" | "probe";

export interface LeakCell {
  role: RoleKey;
  surface: LeakSurface;
  row: LeakRow;
  /** Strings scanned. 0 with built: nothing to check. */
  texts: number;
  leaks: number;
  /** Judge findings whose quote is not in the text: shown, never counted as leaks. */
  unconfirmed: number;
  /** False while the owning module has not registered this surface ("Not built"). */
  built: boolean;
}

export interface LeakFinding {
  row: LeakRow;
  role: RoleKey;
  surface: LeakSurface;
  /** The canary token (token row) or the probe fact id (probe row). */
  item: string;
  by: "token" | "key_terms" | "judge";
  quote: string;
  confirmed: boolean;
}

export interface LeakReport {
  source: "ground_truth" | "pattern";
  tokenCount: number;
  factCount: number;
  compiled: boolean;
  roles: { key: RoleKey; label: string; maySee: number; maySeeFacts: number }[];
  surfaces: { key: LeakSurface; label: string; built: boolean }[];
  rows: readonly LeakRow[];
  cells: LeakCell[];
  /** Cells with something to check, and how many of them fail. */
  checks: number;
  failed: number;
  allPass: boolean;
  textsChecked: number;
  judge: { used: boolean; at: string | null };
  /** Details of every finding. Callers show `quote` and the fact text to the approver only. */
  findings: LeakFinding[];
}

const ROWS: readonly LeakRow[] = ["token", "probe"];

// ---------------------------------------------------------------------------------------------
// The model judge

export const JUDGE_SCHEMA_NAME = "probe_judge_v1";
export const judgeResponseSchema = z.object({
  revealed: z.array(z.object({ fact_id: z.string(), quote: z.string() })),
});
export type JudgeResponse = z.infer<typeof judgeResponseSchema>;

const JUDGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["revealed"],
  properties: {
    revealed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fact_id", "quote"],
        properties: { fact_id: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
};

export const JUDGE_SYSTEM_PROMPT = [
  "You check whether a text reveals confidential facts.",
  "You get a list of confidential facts and one text that a reader is allowed to see.",
  "For each fact, decide whether the text reveals its private detail, in any wording or language, fully or by clear implication.",
  "The private detail is the medical matter, the amount, the debt, the complaint or the incident itself.",
  "A text that only names the same person, organisation, task, topic or date does not reveal the fact. Most texts reveal nothing.",
  "When a fact is revealed, copy the exact words from the text that give the private detail away.",
  'Return JSON only: {"revealed":[{"fact_id":"<id>","quote":"<exact words from the text>"}]}. Return an empty list when nothing is revealed.',
].join("\n");

/**
 * The second look. The judge tends to flag a text that merely names the person or the topic of a
 * fact. Each of its findings is therefore put to it again, alone: one fact, one quote, yes or no.
 * A finding it withdraws is dropped. This only filters what the judge itself added: a key-term
 * finding is never put to the judge and cannot be withdrawn by it.
 */
export const VERIFY_SCHEMA_NAME = "probe_verify_v1";
export const verifyResponseSchema = z.object({ reveals: z.boolean() });
export const VERIFY_SYSTEM_PROMPT = [
  "You verify one finding of a privacy check.",
  "You get one confidential fact and one quote from a text that a reader is allowed to see.",
  "Decide whether the quote, read on its own, gives away the private detail of the fact: the medical matter, the amount, the debt, the complaint or the incident itself, in any wording.",
  "A quote that only names the person, the organisation, the task, the topic or a date, without the private detail, does not give it away.",
  'Return JSON only: {"reveals": true} or {"reveals": false}.',
].join("\n");

export function verifyUserPrompt(fact: ProbeFact, quote: string): string {
  return [`Confidential fact: ${fact.fact ?? fact.termGroups.map((g) => g[0]).join(", ")}`, "", "Quote:", "<<<", quote.trim(), ">>>"].join("\n");
}

export function judgeUserPrompt(facts: readonly ProbeFact[], chunk: string): string {
  return [
    "Confidential facts:",
    ...facts.map((f) => `[${f.id}] ${f.fact ?? f.termGroups.map((g) => g[0]).join(", ")}`),
    "",
    "Text:",
    "<<<",
    chunk,
    ">>>",
  ].join("\n");
}

/** One model call of the judge: `kind` says which of its two questions is asked. The answer is validated here. */
export type JudgeCall = (opts: { kind: "judge" | "verify"; system: string; user: string }) => Promise<CallResult<unknown>>;

/** The judge over the shared model client. `cacheOnly` skips the network (model down, or a time box used up). */
export function modelJudgeCall(opts: { cacheOnly: () => boolean; timeoutMs?: () => number; retries?: number }): JudgeCall {
  return (o) => callJson({
    system: o.system,
    user: o.user,
    schema: (o.kind === "judge" ? judgeResponseSchema : verifyResponseSchema) as z.ZodType<unknown>,
    jsonSchemaName: o.kind === "judge" ? JUDGE_SCHEMA_NAME : VERIFY_SCHEMA_NAME,
    jsonSchema: o.kind === "judge" ? JUDGE_JSON_SCHEMA : undefined,
    cacheOnly: opts.cacheOnly(),
    timeoutMs: opts.timeoutMs?.() ?? 60_000,
    retries: opts.retries ?? 1,
  });
}

async function defaultJudgeCall(): Promise<JudgeCall> {
  const up = await modelAvailable();
  return modelJudgeCall({ cacheOnly: () => !up });
}

async function ask(call: JudgeCall, o: Parameters<JudgeCall>[0]): Promise<CallResult<unknown>> {
  try {
    return await call(o);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ask the judge about one piece of text, then put each of its findings to it again (the second
 * look). Returns its answers, or null when it could not be asked. An answer the second look
 * withdrew comes back with verified false (mergeJudge drops it); one the second look could not be
 * asked about comes back with verified null (kept as unconfirmed).
 */
export async function judgeText(
  facts: readonly ProbeFact[], surface: string, chunk: string, call: JudgeCall,
): Promise<JudgeAnswer[] | null> {
  if (!facts.length || !chunk.trim()) return [];
  const res = await ask(call, { kind: "judge", system: JUDGE_SYSTEM_PROMPT, user: judgeUserPrompt(facts, chunk) });
  if (!res.ok) return null;
  const parsed = judgeResponseSchema.safeParse(res.data);
  if (!parsed.success) return null;
  const byId = new Map(facts.map((f) => [f.id, f]));
  const out: JudgeAnswer[] = [];
  const text = chunk.replace(/\s+/g, " ").toLowerCase();
  for (const r of parsed.data.revealed) {
    const fact = byId.get(r.fact_id);
    if (!fact) continue;
    const quote = r.quote.trim();
    // A quote that is not in the text is not worth a second call: it is unconfirmed either way.
    if (quote.length < 4 || !text.includes(quote.replace(/\s+/g, " ").toLowerCase())) {
      out.push({ factId: fact.id, surface, quote, chunk });
      continue;
    }
    const second = await ask(call, { kind: "verify", system: VERIFY_SYSTEM_PROMPT, user: verifyUserPrompt(fact, quote) });
    const verdict = second.ok ? verifyResponseSchema.safeParse(second.data) : null;
    out.push({ factId: fact.id, surface, quote, chunk, verified: verdict?.success ? verdict.data.reveals : null });
  }
  return out;
}

async function pool<T>(items: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// ---------------------------------------------------------------------------------------------
// The grid

interface StoredFinding { factId: string; role: RoleKey; surface: LeakSurface; by: "key_terms" | "judge"; quote: string; confirmed: boolean }

interface GridOptions {
  /** Judge findings to merge in (from a stored run, or fresh ones). */
  judgeFindings?: StoredFinding[];
  /** Run the judge now with this call. */
  judgeCall?: JudgeCall;
  judge?: { used: boolean; at: string | null };
}

interface Grid { report: LeakReport; judgeCalls: number; judgeFailed: number; judgeWithdrawn: number }

async function buildGrid(ws: string, opts: GridOptions = {}): Promise<Grid> {
  const pack = await getWorkspacePack(ws);
  const [tokens, facts] = await Promise.all([canaryTokens(ws), probeFacts(ws)]);
  const roles = pack.roles.map((r) => r.key as RoleKey);
  const factIds = new Set(facts.map((f) => f.id));
  const cells: LeakCell[] = [];
  const findings: LeakFinding[] = [];
  const built = new Map<LeakSurface, boolean>();
  let compiled = false;
  let textsChecked = 0;
  let judgeCalls = 0;
  let judgeFailed = 0;
  let judgeWithdrawn = 0;

  for (const role of roles) {
    const handover = await compileHandover(ws, role);
    if (handover.doc) compiled = true;
    const hidden = hiddenFacts(facts, role);
    const surfaces = await collectSurfaces(ws, role, handover);
    for (const s of surfaces) {
      built.set(s.key, s.built);
      textsChecked += s.texts.length;
      const tokenLeaks = s.built ? scanForCanaries(s.texts, tokens.allowed.get(role) ?? new Set(), tokens.all) : [];
      for (const l of tokenLeaks) findings.push({ row: "token", role, surface: s.key, item: l.token, by: "token", quote: l.token, confirmed: true });
      cells.push({ role, surface: s.key, row: "token", texts: s.texts.length, leaks: tokenLeaks.length, unconfirmed: 0, built: s.built });

      let probeFindings: ProbeFinding[] = s.built ? scanForFacts(s.texts, role, facts) : [];
      const answers: JudgeAnswer[] = [];
      if (s.built && hidden.length && opts.judgeCall) {
        const chunks = judgeChunks(s.texts.map((t) => t.text));
        await pool(chunks, 4, async (chunk) => {
          judgeCalls++;
          const res = await judgeText(hidden, s.key, chunk, opts.judgeCall!);
          if (res === null) judgeFailed++;
          else {
            answers.push(...res);
            judgeWithdrawn += res.filter((a) => a.verified === false).length;
            // A second look that could not be asked leaves the text half read: say so, so a rerun finishes it.
            if (res.some((a) => a.verified === null)) judgeFailed++;
          }
        });
      }
      for (const f of opts.judgeFindings ?? []) {
        if (f.by !== "judge" || f.role !== role || f.surface !== s.key || !s.built) continue;
        // A stored judge finding is re-checked against the text shown now: its quote must still be there.
        const chunk = s.texts.map((t) => t.text).join("\n");
        answers.push({ factId: f.factId, surface: s.key, quote: f.quote, chunk: f.confirmed ? chunk : "" });
      }
      probeFindings = mergeJudge(probeFindings, answers, factIds);
      for (const f of probeFindings) {
        findings.push({ row: "probe", role, surface: s.key, item: f.factId, by: f.by, quote: f.quote, confirmed: f.confirmed });
      }
      cells.push({
        role, surface: s.key, row: "probe",
        texts: hidden.length ? s.texts.length : 0,
        leaks: probeFindings.filter((f) => f.confirmed).length,
        unconfirmed: probeFindings.filter((f) => !f.confirmed).length,
        built: s.built,
      });
    }
  }

  const checked = cells.filter((c) => c.built && c.texts > 0);
  const failed = checked.filter((c) => c.leaks > 0).length;
  const report: LeakReport = {
    source: tokens.source,
    tokenCount: tokens.all.length,
    factCount: facts.length,
    compiled,
    roles: roles.map((key) => ({
      key, label: roleLabel(key, pack), maySee: tokens.allowed.get(key)?.size ?? 0,
      maySeeFacts: facts.filter((f) => f.roleSet.includes(key)).length,
    })),
    surfaces: LEAK_SURFACES.map((key) => ({ key, label: SURFACE_LABELS[key], built: built.get(key) ?? false })),
    rows: ROWS,
    cells,
    checks: checked.length,
    failed,
    allPass: failed === 0,
    textsChecked,
    judge: opts.judge ?? { used: false, at: null },
    findings,
  };
  return { report, judgeCalls, judgeFailed, judgeWithdrawn };
}

// ---------------------------------------------------------------------------------------------
// Stored runs

export interface ProbeRunSummary {
  checks: number;
  failed: number;
  textsChecked: number;
  tokenLeaks: number;
  probeLeaks: number;
  unconfirmed: number;
  judgeCalls: number;
  judgeFailed: number;
  /** Findings the judge raised and then withdrew at its second look. */
  judgeWithdrawn: number;
  byKeyTerms: number;
  byJudge: number;
}

export interface ProbeRun {
  id: string;
  createdAt: string;
  actor: string;
  snapshotId: string | null;
  modelTag: string;
  judgeUsed: boolean;
  cells: LeakCell[];
  findings: StoredFinding[];
  summary: ProbeRunSummary;
}

function toProbeRun(r: Record<string, unknown>): ProbeRun {
  return {
    id: String(r.id),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    actor: String(r.actor),
    snapshotId: (r.snapshot_id as string | null) ?? null,
    modelTag: String(r.model_tag ?? ""),
    judgeUsed: Boolean(r.judge_used),
    cells: parseStoredJson<LeakCell[]>(r.cells, []),
    findings: parseStoredJson<StoredFinding[]>(r.findings, []),
    summary: parseStoredJson<ProbeRunSummary>(r.summary, {} as ProbeRunSummary),
  };
}

async function currentSnapshotId(ws: string): Promise<string | null> {
  const [row] = await db()`SELECT id FROM snapshots WHERE workspace_id = ${ws} ORDER BY version DESC LIMIT 1`;
  return row ? String(row.id) : null;
}

/** The latest stored probe run of the workspace, or null. Admin read: callers gate what they show. */
export async function latestProbeRun(ws: string): Promise<ProbeRun | null> {
  const [row] = await db()`SELECT * FROM probe_runs WHERE workspace_id = ${ws} ORDER BY created_at DESC LIMIT 1`;
  return row ? toProbeRun(row) : null;
}

/**
 * The Leak check grid, live. Token scan and key-term probes run on what each role is shown now.
 * With `judge: "stored"` (default) the judge findings of the latest stored run for the current
 * snapshot are merged in; the judge itself never runs on a page render.
 */
export async function runLeakCheck(ws: string, opts: { judge?: "stored" | "off" } = {}): Promise<LeakReport> {
  let judgeFindings: StoredFinding[] = [];
  let judge = { used: false, at: null as string | null };
  if (opts.judge !== "off") {
    const [run, snap] = await Promise.all([latestProbeRun(ws), currentSnapshotId(ws)]);
    if (run && run.judgeUsed && run.snapshotId === snap) {
      judgeFindings = run.findings;
      judge = { used: true, at: run.createdAt };
    }
  }
  return (await buildGrid(ws, { judgeFindings, judge })).report;
}

/**
 * Run the probes and store the result. With the judge (default when a model or a cached answer is
 * there) every role's surfaces are also read by the model judge. One probe_runs row per call.
 */
export async function runProbes(
  ws: string, actor: string, opts: { judge?: boolean; call?: JudgeCall } = {},
): Promise<{ run: ProbeRun; report: LeakReport }> {
  const useJudge = opts.judge !== false;
  const call = useJudge ? (opts.call ?? await defaultJudgeCall()) : undefined;
  const at = new Date().toISOString();
  const grid = await buildGrid(ws, { judgeCall: call, judge: { used: false, at: null } });
  // The judge counts as used when at least one of its calls came back.
  const judgeUsed = Boolean(call) && grid.judgeCalls > 0 && grid.judgeFailed < grid.judgeCalls;
  const report: LeakReport = { ...grid.report, judge: { used: judgeUsed, at: judgeUsed ? at : null } };
  const probe = report.findings.filter((f) => f.row === "probe");
  const summary: ProbeRunSummary = {
    checks: report.checks,
    failed: report.failed,
    textsChecked: report.textsChecked,
    tokenLeaks: report.findings.filter((f) => f.row === "token").length,
    probeLeaks: probe.filter((f) => f.confirmed).length,
    unconfirmed: probe.filter((f) => !f.confirmed).length,
    judgeCalls: grid.judgeCalls,
    judgeFailed: grid.judgeFailed,
    judgeWithdrawn: grid.judgeWithdrawn,
    byKeyTerms: probe.filter((f) => f.by === "key_terms").length,
    byJudge: probe.filter((f) => f.by === "judge" && f.confirmed).length,
  };
  const stored: StoredFinding[] = probe.map((f) => ({
    factId: f.item, role: f.role, surface: f.surface, by: f.by === "judge" ? "judge" : "key_terms", quote: f.quote, confirmed: f.confirmed,
  }));
  const id = `prb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const snapshotId = await currentSnapshotId(ws);
  const [row] = await db()`
    INSERT INTO probe_runs (workspace_id, id, created_at, actor, snapshot_id, model_tag, judge_used, cells, findings, summary)
    VALUES (${ws}, ${id}, ${at}, ${actor}, ${snapshotId}, ${modelTag()}, ${judgeUsed},
      ${JSON.stringify(report.cells)}::jsonb, ${JSON.stringify(stored)}::jsonb, ${JSON.stringify(summary)}::jsonb)
    RETURNING *`;
  await audit(ws, actor, "run_probes", { id, judgeUsed, checks: summary.checks, failed: summary.failed, judgeCalls: summary.judgeCalls });
  return { run: toProbeRun(row), report };
}
