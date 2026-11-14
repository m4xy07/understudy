// Surface registry for the leak check. Contract: docs/ARCHITECTURE.md section 4a,
// docs/round3/specs/02_confidentiality.md section 9.1.
//
// A surface is one place where a role is shown text. Each provider returns the exact strings that
// role would be shown, read the same way the page reads them: inside withRole, or through the
// page's own data function. The leak check then looks for canary tokens and reworded facts in them.
// A provider that returns "not_built" belongs to a module that has not registered its texts yet:
// its column reads "Not built" and is left out of the pass count.
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { getLatestTestRun, listClaims, listResponsibilities } from "@/lib/db/queries";
import { listQuestions, toLacunaPack } from "@/lib/lacuna";
import { checksFor } from "@/lib/lacuna/core/checks";
import { questionText } from "@/lib/lacuna/core/questions";
import { getWorkspacePack, roleLabel, type ResolvedPack } from "@/lib/pack";
import { sensitiveSummary } from "@/lib/tether/visibility";
import type { RoleKey } from "@/lib/types";
import { surfacesOf, type Surface } from "./core/canary";
import { formatScores, renderMarkdown } from "./core/compile";
import { EXTERNAL_SURFACES } from "./surface-sources";
import type { Handover } from "./handover";

export const LEAK_SURFACES = [
  "handover", "export", "stubs", "scores", "timeline", "questions", "conflicts", "claims", "test_notes",
  "sensitive_panel", "graph", "neighbour_questions", "traces", "ranked_options", "changes",
] as const;
export type LeakSurface = (typeof LEAK_SURFACES)[number];

export const SURFACE_LABELS: Record<LeakSurface, string> = {
  handover: "Handover text",
  export: "Export",
  stubs: "Stubs",
  scores: "Scores",
  timeline: "Timeline",
  questions: "Questions",
  conflicts: "Conflict flags",
  claims: "Claim list",
  test_notes: "Test notes",
  sensitive_panel: "Sensitive panel",
  graph: "People graph",
  neighbour_questions: "Neighbour questions",
  traces: "Traces",
  ranked_options: "Ranked options",
  changes: "What changed",
};

/** What a provider is given: the workspace, the role, and that role's compiled handover (compiled once). */
export interface SurfaceContext {
  ws: string;
  role: RoleKey;
  pack: ResolvedPack;
  handover: Handover;
}

export interface SurfaceProvider {
  key: LeakSurface;
  label: string;
  collect(ctx: SurfaceContext): Promise<Surface[] | "not_built">;
}

const as = (key: LeakSurface, texts: readonly (string | null | undefined)[]): Surface[] =>
  texts.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((text) => ({ surface: key, text }));

type Row = Record<string, unknown>;

/** The coverage words the Test page shows (docs/ARCHITECTURE.md section 2). */
const COVERAGE_LABEL: Record<string, string> = {
  covered: "Covered", partial: "Partial", missing: "Missing", restricted: "Restricted", conflicting: "Conflicting",
};

function parseJson<T>(v: unknown, fallback: T): T {
  let x = v;
  for (let i = 0; i < 2 && typeof x === "string"; i++) {
    try { x = JSON.parse(x); } catch { return fallback; }
  }
  return (x ?? fallback) as T;
}

/** Gap question texts exactly as the Ask page shows them to `role`, plus the leaver's answers it can read. */
async function questionTexts({ ws, role, pack }: SurfaceContext): Promise<string[]> {
  const [questions, responsibilities] = await Promise.all([listQuestions(ws), listResponsibilities(ws)]);
  const lpack = toLacunaPack(pack);
  const byId = new Map(responsibilities.map((r) => [r.id, r]));
  // The Ask page shows a conflicting question in full to the leaver, the approver and the successor only.
  const fullText = role === pack.leaverRole || role === pack.approverRole || role === pack.successorRole;
  const out: string[] = [];
  for (const q of questions) {
    const r = byId.get(q.responsibilityId);
    if (fullText || q.gapType !== "conflicting" || !r) {
      out.push(q.text);
    } else {
      const check = checksFor(r, lpack).find((c) => c.key === q.checkKey);
      out.push(check ? questionText({ gapType: "conflicting", claimIds: [] }, r, check, r.kind, [], pack.leaverRole) : q.text);
    }
    if (r) out.push(r.title);
    if (q.scoreDelta) out.push(q.scoreDelta);
  }
  // Answers: the claim a leaver's answer became, when this role may read it (RLS decides).
  const answerIds = questions.map((q) => q.answeredClaimId).filter((x): x is string => Boolean(x));
  if (answerIds.length) {
    const rows = await withRole(ws, role, (tx) => tx`
      SELECT statement, value FROM claims WHERE workspace_id = ${ws} AND id = ANY(${answerIds}::text[])`);
    for (const a of rows) out.push(`${String(a.statement)}\n${String(a.value)}`);
  }
  return out;
}

/** Everything the Claims page lists for `role`: read under RLS, like the page. */
async function claimTexts({ ws, role }: SurfaceContext): Promise<{ claims: string[]; flags: string[] }> {
  const claims = await listClaims(ws, { role });
  const byId = new Map(claims.map((c) => [c.id, c]));
  const out: string[] = [];
  const flags: string[] = [];
  for (const c of claims) {
    out.push(`${c.entityLabel}\n${c.statement}\n${c.value}`);
    if (c.stateNote) flags.push(c.stateNote);
    if (c.supersededBy) {
      // The page links "Superseded by" to the winner only when this role can read the winner.
      const winner = byId.get(c.supersededBy);
      flags.push(winner ? `Superseded by: ${winner.statement}` : "Superseded");
    }
    if (c.reviewNote) out.push(c.reviewNote);
  }
  let dropped: Row[] = [];
  try {
    dropped = await withRole(ws, role, (tx) => tx`
      SELECT entity, statement, reason FROM attest_dropped WHERE workspace_id = ${ws}`);
  } catch {
    dropped = [];
  }
  for (const d of dropped) out.push(`${String(d.entity)}\n${String(d.statement)}\n${String(d.reason)}`);
  return { claims: out, flags };
}

/** Stand-in results as the Test page shows them to `role`: notes for the tested role and the approver only. */
async function testTexts({ ws, role, pack }: SurfaceContext): Promise<{ notes: string[]; coverage: string[] }> {
  const notes: string[] = [];
  const coverage: string[] = [];
  for (const target of pack.testRoles) {
    const run = await getLatestTestRun(ws, target);
    if (!run) continue;
    const showNotes = role === target || role === pack.approverRole;
    for (const r of run.results) {
      coverage.push(COVERAGE_LABEL[r.coverage] ?? r.coverage);
      if (showNotes && r.note) notes.push(r.note);
    }
    const [m] = await db()`SELECT model_note FROM test_runs WHERE workspace_id = ${ws} AND id = ${run.id}`;
    if (m?.model_note) notes.push(String(m.model_note));
  }
  return { notes, coverage: [...new Set(coverage)] };
}

/** Everything the "Sensitive content" panel on Connect renders for `role`, the count lines included. */
async function sensitivePanelTexts({ ws, role, pack }: SurfaceContext): Promise<string[]> {
  const s = await sensitiveSummary(ws, role);
  const approver = roleLabel(pack.approverRole, pack);
  const out: string[] = [];
  for (const r of s.rows) {
    out.push([
      r.sourceName, r.authorName ?? "", r.text, r.reason ?? "", r.note ?? "",
      r.roleSet.map((k) => roleLabel(k, pack)).join(", "), r.roleSetOriginal.map((k) => roleLabel(k, pack)).join(", "),
    ].join("\n"));
  }
  out.push(`${s.limited} limited · ${s.held} held for you to check · ${s.widened} widened by you`);
  if (s.hidden > 0) out.push(`${s.hidden} messages in sources you can open are limited to fewer roles. Ask the approver (${approver}).`);
  for (const n of Object.values(s.perSource)) out.push(`${n} limited`);
  return out;
}

function fromHandover(key: LeakSurface, pick: (h: Handover) => string[]): SurfaceProvider {
  return { key, label: SURFACE_LABELS[key], collect: async ({ handover }) => as(key, handover.doc ? pick(handover) : []) };
}

function external(key: "graph" | "neighbour_questions" | "traces" | "ranked_options"): SurfaceProvider {
  return {
    key,
    label: SURFACE_LABELS[key],
    collect: async ({ ws, role }) => {
      const fn = EXTERNAL_SURFACES.recoverySurfaces;
      if (typeof fn !== "function") return "not_built";
      return as(key, (await fn(ws, role)).filter((s) => s.surface === key).map((s) => s.text));
    },
  };
}

/** Per-request memo, so providers that share one read (claims and conflict flags) read once. */
function memo<T>(fn: (ctx: SurfaceContext) => Promise<T>): (ctx: SurfaceContext) => Promise<T> {
  const cache = new WeakMap<SurfaceContext, Promise<T>>();
  return (ctx) => {
    let p = cache.get(ctx);
    if (!p) cache.set(ctx, (p = fn(ctx)));
    return p;
  };
}

const claimsOnce = memo(claimTexts);
const testOnce = memo(testTexts);

/** The registry, in column order. */
export const SURFACE_PROVIDERS: SurfaceProvider[] = [
  {
    key: "handover",
    label: SURFACE_LABELS.handover,
    collect: async ({ handover: h }) => {
      if (!h.doc) return [];
      const doc = surfacesOf(h.doc, { export: [] }).filter((s) => s.surface.startsWith("handover:")).map((s) => s.text);
      const groups = h.groups.flatMap((g) => g.items.map((it) => `${it.entityLabel} ${it.statement}`));
      return as("handover", [...doc, ...groups]);
    },
  },
  fromHandover("export", (h) => [renderMarkdown(h.doc!)]),
  fromHandover("stubs", (h) => [
    ...h.doc!.sections.flatMap((s) => s.lines.filter((l) => l.kind === "stub").map((l) => l.text)),
    ...(h.stubLine ? [h.stubLine] : []),
  ]),
  fromHandover("scores", (h) => [...(h.scores ? [formatScores(h.scores)] : []), h.doc!.snapshot.releaseLabel]),
  fromHandover("timeline", (h) => h.doc!.sections.find((s) => s.key === "timeline")?.lines.map((l) => l.text) ?? []),
  { key: "questions", label: SURFACE_LABELS.questions, collect: async (ctx) => as("questions", await questionTexts(ctx)) },
  {
    key: "conflicts",
    label: SURFACE_LABELS.conflicts,
    collect: async (ctx) => {
      const lines = ctx.handover.doc?.sections.flatMap((s) => s.lines.filter((l) => l.kind === "conflict").map((l) => l.text)) ?? [];
      return as("conflicts", [...lines, ...(await claimsOnce(ctx)).flags, ...(await testOnce(ctx)).coverage]);
    },
  },
  { key: "claims", label: SURFACE_LABELS.claims, collect: async (ctx) => as("claims", (await claimsOnce(ctx)).claims) },
  { key: "test_notes", label: SURFACE_LABELS.test_notes, collect: async (ctx) => as("test_notes", (await testOnce(ctx)).notes) },
  { key: "sensitive_panel", label: SURFACE_LABELS.sensitive_panel, collect: async (ctx) => as("sensitive_panel", await sensitivePanelTexts(ctx)) },
  external("graph"),
  external("neighbour_questions"),
  external("traces"),
  external("ranked_options"),
  {
    key: "changes",
    label: SURFACE_LABELS.changes,
    collect: async ({ ws, role }) => {
      const fn = EXTERNAL_SURFACES.changeTexts;
      if (typeof fn !== "function") return "not_built";
      return as("changes", await fn(ws, role));
    },
  },
];

export interface CollectedSurface {
  key: LeakSurface;
  label: string;
  built: boolean;
  texts: Surface[];
}

/** Every surface of one role. `handover` is that role's compiled handover. */
export async function collectSurfaces(ws: string, role: RoleKey, handover: Handover): Promise<CollectedSurface[]> {
  const pack = await getWorkspacePack(ws);
  const ctx: SurfaceContext = { ws, role, pack, handover };
  const out: CollectedSurface[] = [];
  for (const p of SURFACE_PROVIDERS) {
    const res = await p.collect(ctx);
    out.push({ key: p.key, label: p.label, built: res !== "not_built", texts: res === "not_built" ? [] : res });
  }
  return out;
}

export { parseJson as parseStoredJson };
