// Attest: reconstruct claims from a workspace's segments and verify them.
// Contract: docs/ARCHITECTURE.md section 4 "Claims (Attest)". The pure rules live in ./core;
// this file loads and stores (admin path, logged in claim_events).
//
// Public entry points the pipeline calls (names and shapes kept from the walking skeleton):
//   reconstruct(ws) -> ReconstructResult   task/event rows -> structured drafts (no model);
//                                          every other segment -> model drafts (per thread, one role
//                                          set per call, concurrency 4). Drafts are stored in
//                                          attest_runs; claims are written by verify().
//   verify(ws)      -> VerifyResult        verifyDrafts -> support check (model, can only lower
//                                          trust) -> rules (supersession, conflicts, corroboration,
//                                          importance, tier) -> upsert claims (review work kept)
//                                          + claim_events for every change + attest_dropped.
// Helpers other modules import: claimId, matchEntity, intersectRoles, tierFor.
import { db } from "@/lib/db/client";
import { claimRow, toClaim, toSegment } from "@/lib/db/mappers";
import { peopleNames } from "@/lib/db/queries";
import { getWorkspacePack, type Pack, type ResolvedPack } from "@/lib/pack";
import { modelAvailable } from "@/lib/model/client";
import { norm, sha256Hex } from "@/lib/text/norm";
import type { Attribute, Claim, ResponsibilityKind, ReviewTier, RoleKey, Segment, SourceKind } from "@/lib/types";
import { extractClaims, type BatchReport } from "./core/extract";
import { structuredClaims, matchEntity as matchPackEntity } from "./core/structured";
import { OTHER_ENTITY, resolvePromptVariant, type DraftClaim, type ExtractionPack, type OffListClaim, type PromptVariant } from "./core/schema";
import { consolidate, exampleValues, type ConsolidationFiring, type ConsolidationRule } from "./core/consolidate";
import {
  claimId as coreClaimId,
  intersectRoleSets,
  verifyDrafts,
  type DraftClaim as VerifyDraft,
  type DroppedDraft,
} from "./core/verify";
import { applyRules, isSensitive, tierOf, type RuleFiring } from "./core/rules";
import { flagRoleSets } from "./core/flags";
import { EXTRACTION_SKIP_KINDS, isCarriedOrigin, isRecordOrigin, takesPartInRules } from "./core/origins";
import type { AttestPack } from "./core/verify";
import { supportCheck, weakerTrust } from "./core/support";
import { attestModelCall, newStats } from "./model";
import { toIsoDate } from "./dates";

export interface ReconstructResult {
  claims: number;        // drafts produced in this pass (structured + model)
  total: number;         // drafts stored for verify()
  modelUsed: boolean;
  modelNote: string | null;
  /** The extraction prompt this run used ("v2": two passes; "r2": the Round 2 prompt). */
  variant: PromptVariant;
  /** What the consolidation pass did; null when it did not run. */
  consolidation: { counts: Record<ConsolidationRule, number>; firings: ConsolidationFiring[]; before: number; after: number } | null;
}

export interface VerifyResult {
  checked: number;
  fromRecord: number;
  corroborated: number;
  inferred: number;
  /** draftsDropped + claimsRetired. The two are different things and are shown apart. */
  dropped: number;
  /** Drafts of this run that lost their citation in verification (the Claims page lists them per source). */
  draftsDropped: number;
  /** Claims an earlier run produced that this run no longer finds (kept, with state Dropped). */
  claimsRetired: number;
  superseded: number;
  conflicting: number;
  firings: number;
  supportChecked: number;
  supportLowered: number;
}

export interface ReconstructOptions {
  /** Inject a model call (tests). Default: callJson, cache-only when the endpoint is down. */
  call?: Parameters<typeof extractClaims>[2];
  /** false: structured sources only. */
  useModel?: boolean;
  concurrency?: number;
  /** Default: the environment (ATTEST_PROMPT), then the pack (extraction.prompt), then DEFAULT_PROMPT_VARIANT. */
  variant?: PromptVariant;
  /** Run the consolidation pass. Default: on for both prompts (ATTEST_CONSOLIDATE=0 turns it off). */
  consolidate?: boolean;
}

/** The extraction variant for a pack: ATTEST_PROMPT first, then the pack's `extraction.prompt`. */
export function promptVariantFor(pack: Pick<ExtractionPack, "prompt">): PromptVariant {
  return resolvePromptVariant(process.env.ATTEST_PROMPT, pack.prompt);
}

/** Consolidation runs after either prompt; ATTEST_CONSOLIDATE=0 gives the bare drafts of the prompt. */
function consolidationOn(): boolean {
  const v = (process.env.ATTEST_CONSOLIDATE ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

export interface VerifyOptions {
  call?: Parameters<typeof supportCheck>[2];
  /** Run the model support check (default true; skipped when the model is unavailable and uncached). */
  support?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Helpers shared with other modules

export function claimId(entity: string, attribute: string, value: string, segmentIds: string[]): string {
  return coreClaimId(entity, attribute as Attribute, value, segmentIds);
}

/** The part of the pack extraction reads: entities, and the pack's own prompt examples and hints. */
export function extractionPack(pack: Pack): ExtractionPack {
  return {
    entities: pack.entities.map((e) => {
      const partOf = (e as { partOf?: unknown }).partOf;
      return {
        key: e.key,
        label: e.label,
        aliases: [...(e.aliases ?? [])],
        ...(typeof partOf === "string" ? { partOf } : {}),
      };
    }),
    examples: pack.extraction?.examples as ExtractionPack["examples"],
    entityHint: pack.extraction?.entityHint,
    contactExample: pack.extraction?.contactExample,
    promptExamples: pack.extraction?.promptExamples as ExtractionPack["promptExamples"],
    prompt: typeof pack.extraction?.prompt === "string" ? pack.extraction.prompt : undefined,
  };
}

/** The part of the pack the Attest rules read. */
export function attestPack(pack: ResolvedPack): AttestPack {
  return { ...(pack as unknown as AttestPack), roleOrder: pack.roleOrder, restrictedAudience: pack.restrictedAudienceRoles };
}

function slugOf(text: string): string {
  return norm(text).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "untitled";
}

/** Pack entity named (key, label or alias, whole words) in the text; else a slug of the fallback. */
export function matchEntity(text: string, fallback: string, pack: Pack): { key: string; label: string } {
  const hit = matchPackEntity(extractionPack(pack), text, fallback);
  if (hit.entity !== OTHER_ENTITY) {
    const e = pack.entities.find((x) => x.key === hit.entity)!;
    return { key: e.key, label: e.label };
  }
  return { key: slugOf(fallback), label: fallback.trim() || slugOf(fallback) };
}

export function intersectRoles(sets: RoleKey[][], pack: Pick<ResolvedPack, "roleOrder">): RoleKey[] {
  return intersectRoleSets(sets, pack.roleOrder);
}

export function tierFor(
  c: Pick<Claim, "roleSet" | "state" | "importance" | "trust"> & Partial<Claim>,
  pack: Pick<ResolvedPack, "restrictedAudienceRoles">,
): ReviewTier {
  const restricted = pack.restrictedAudienceRoles;
  if (isSensitive(c.roleSet, restricted) || c.state === "conflicting" || c.importance === "blocking") return "C";
  if (c.citations && c.supportCheck !== undefined) return tierOf(c as Claim, restricted);
  if (c.trust === "corroborated" && c.importance === "normal") return "A";
  return "B";
}

// ---------------------------------------------------------------------------------------------
// Loading

async function loadSegments(ws: string): Promise<Segment[]> {
  const rows = await db()`
    SELECT DISTINCT ON (id) * FROM segments WHERE workspace_id = ${ws}
    ORDER BY id, version DESC`;
  return rows.map(toSegment);
}

/** Head versions of the named segments only (the ones a set of claims cites). */
export async function loadSegmentsByIds(ws: string, ids: readonly string[]): Promise<Segment[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  const rows = await db()`
    SELECT DISTINCT ON (id) * FROM segments WHERE workspace_id = ${ws} AND id = ANY(${wanted}::text[])
    ORDER BY id, version DESC`;
  return rows.map(toSegment);
}

function newestTs(segs: Segment[]): string | null {
  let best: string | null = null;
  for (const s of segs) if (!best || Date.parse(s.ts) > Date.parse(best)) best = s.ts;
  return best;
}

/** Entity -> responsibility kinds, from the pack role templates and the Lacuna inventory. */
async function entityKindsFor(ws: string, pack: Pick<AttestPack, "roleTemplates">): Promise<Map<string, ResponsibilityKind[]>> {
  const out = new Map<string, ResponsibilityKind[]>();
  const add = (e: string, k: ResponsibilityKind) => {
    const list = out.get(e) ?? [];
    if (!list.includes(k)) list.push(k);
    out.set(e, list);
  };
  for (const list of Object.values(pack.roleTemplates ?? {})) {
    for (const t of list ?? []) for (const e of t.entities) add(e, t.kind);
  }
  try {
    const rows = await db()`SELECT kind, entities FROM responsibilities WHERE workspace_id = ${ws}`;
    for (const r of rows) for (const e of (r.entities as string[]) ?? []) add(e, r.kind as ResponsibilityKind);
  } catch {
    // inventory not built yet: role templates only
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// reconstruct

const DONE_STATUS = /^(done|closed|complete|completed|cancelled|canceled|resolved)$/i;
export const EXTRACT_MAX_CHARS = 5_000;
/**
 * Batch size of the two-pass candidate prompt. Smaller than Round 2 on purpose: in a dense chat
 * batch the model skips short messages, and a missed message is a missed claim. More calls, each
 * shorter; the size is part of every candidate cache key.
 */
export const EXTRACT_MAX_CHARS_V2 = 3_000;

/** Normalise deadline values to ISO dates where the value is one date; slug unknown task entities. */
function normaliseDrafts(drafts: DraftClaim[], segsById: Map<string, Segment>): DraftClaim[] {
  return drafts.map((d) => {
    let out = d;
    if (d.attribute === "deadline") {
      const ref = d.citations.map((c) => segsById.get(c.segmentId)?.ts).find(Boolean) ?? null;
      const iso = toIsoDate(d.value, ref);
      if (iso && iso !== d.value) out = { ...out, value: iso };
    }
    // Finished board cards are history: their claims stay under "other", never on a live
    // responsibility (Lacuna's inventory skips them too). An open card about nothing in the pack
    // gets its own entity, the same slug Lacuna's inventory uses for it.
    if (d.origin === "structured") {
      const seg = segsById.get(d.citations[0]?.segmentId ?? "");
      const done = seg?.kind === "task" && DONE_STATUS.test(String(seg.meta?.status ?? "").trim());
      const title = String(seg?.meta?.title ?? d.entityRaw ?? "");
      if (done && d.entity !== OTHER_ENTITY) out = { ...out, entity: OTHER_ENTITY, entityRaw: title || null };
      else if (!done && d.entity === OTHER_ENTITY && d.entityRaw) out = { ...out, entity: slugOf(d.entityRaw) };
    }
    return out;
  });
}

/** Build drafts from the workspace's segments and store them for verify(). */
export async function reconstruct(ws: string, opts: ReconstructOptions = {}): Promise<ReconstructResult> {
  const t0 = Date.now();
  const sql = db();
  const pack = await getWorkspacePack(ws);
  const xpack = extractionPack(pack);
  const segments = await loadSegments(ws);
  const segsById = new Map(segments.map((s) => [s.id, s]));
  const names = await peopleNames(ws).catch(() => ({}) as Record<string, string>);

  const variant = opts.variant ?? promptVariantFor(xpack);
  const structured = structuredClaims(segments, xpack, { now: newestTs(segments) ?? undefined });

  let batches: BatchReport[] = [];
  let modelDrafts: DraftClaim[] = [];
  let offList: OffListClaim[] = [];
  let modelNote: string | null = null;
  // Structured rows are read by code; a person's answers and findings are never sent to the model.
  const textSegments = segments.filter((s) => !EXTRACTION_SKIP_KINDS.includes(s.kind));

  if (opts.useModel === false) {
    modelNote = textSegments.length ? "Model step skipped: claims from the task board and calendar only." : null;
  } else if (textSegments.length) {
    const up = opts.call ? true : await modelAvailable();
    const stats = newStats();
    const call = opts.call ?? attestModelCall({ cacheOnly: !up, stats });
    const xopts = {
      concurrency: opts.concurrency ?? 4,
      // ~1,700 tokens of segments per call: answers are output-bound (~30 tokens/s on OpenRouter,
      // 50-70 s measured for a full batch), inside the 120 s timeout. The batch size is part of every
      // extraction cache key: changing it makes the committed demo cache miss until precompute reruns.
      maxChars: variant === "v2" ? EXTRACT_MAX_CHARS_V2 : EXTRACT_MAX_CHARS,
      roleOrder: pack.roleOrder,
      skipKinds: EXTRACTION_SKIP_KINDS,
      authorLabel: (id: string | null) => (id ? (names[id] ?? id) : "unknown"),
      variant,
    };
    const res = await extractClaims(segments, xpack, call, xopts);
    batches = res.batches;
    modelDrafts = res.drafts;
    offList = res.offListClaims;
    const ok = batches.filter((b) => b.ok).length;
    const cached = batches.filter((b) => b.ok && b.cached).length;
    const failed = batches.length - ok;
    if (!up && ok === 0) {
      modelNote = `Model unavailable: claims from the task board and calendar only. ${batches.length} chat, note and code batches were not read.`;
    } else if (!up && failed === 0) {
      // Every batch replayed from the cache: nothing was missed, so this is not a warning.
      modelNote = `Read ${batches.length} batches (${cached} from the cache).`;
    } else if (!up) {
      modelNote = `Model unavailable: replayed ${cached} of ${batches.length} batches from the cache; ${failed} not read.`;
    } else if (failed) {
      const why = batches.find((b) => !b.ok)?.error ?? "model error";
      modelNote = `${failed} of ${batches.length} batches failed (${why.slice(0, 120)}); their segments have no model claims.`;
    } else {
      modelNote = `Read ${batches.length} batches (${cached} from the cache).`;
    }
  }

  const normalised = normaliseDrafts([...structured, ...modelDrafts], segsById);
  // Second pass (code only): tidy the candidates before the verifier and the rules see them.
  const pass2 = (opts.consolidate ?? consolidationOn())
    ? consolidate(normalised, {
        entities: xpack.entities,
        segmentsById: segsById,
        roleOrder: pack.roleOrder,
        // Only the candidate prompt prints these examples; the Round 2 prompt has its own.
        exampleValues: variant === "v2" ? exampleValues(xpack.promptExamples) : [],
      })
    : null;
  const drafts = pass2 ? pass2.drafts : normalised;
  const modelUsed = batches.some((b) => b.ok);
  const ms = Date.now() - t0;
  await sql`
    INSERT INTO attest_runs (workspace_id, drafts, batches, off_list, model_used, model_note, extract_ms, extracted_at)
    VALUES (${ws}, ${JSON.stringify(drafts)}::jsonb, ${JSON.stringify(batches)}::jsonb, ${JSON.stringify(offList)}::jsonb,
            ${modelUsed}, ${modelNote}, ${ms}, now())
    ON CONFLICT (workspace_id) DO UPDATE SET
      drafts = EXCLUDED.drafts, batches = EXCLUDED.batches, off_list = EXCLUDED.off_list,
      model_used = EXCLUDED.model_used, model_note = EXCLUDED.model_note, extract_ms = EXCLUDED.extract_ms,
      extracted_at = now()`;
  return {
    claims: drafts.length,
    total: drafts.length,
    modelUsed,
    modelNote,
    variant,
    consolidation: pass2 ? { counts: pass2.counts, firings: pass2.firings, before: normalised.length, after: drafts.length } : null,
  };
}

// ---------------------------------------------------------------------------------------------
// verify

export interface StoredExtraction {
  drafts: DraftClaim[];
  batches: BatchReport[];
  offList: OffListClaim[];
  modelUsed: boolean;
  modelNote: string | null;
  extractMs: number | null;
  verification: VerificationSummary | null;
}

export interface VerificationSummary {
  result: VerifyResult;
  firings: RuleFiring[];
  droppedBySource: Record<string, number>;
  supportNote: string | null;
  ms: number;
}

/** jsonb comes back parsed, or as a JSON string when it was written as a string parameter. */
export function jsonValue<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

export async function getExtraction(ws: string): Promise<StoredExtraction | null> {
  const [r] = await db()`SELECT * FROM attest_runs WHERE workspace_id = ${ws}`;
  if (!r) return null;
  return {
    drafts: jsonValue<DraftClaim[]>(r.drafts, []),
    batches: jsonValue<BatchReport[]>(r.batches, []),
    offList: jsonValue<OffListClaim[]>(r.off_list, []),
    modelUsed: Boolean(r.model_used),
    modelNote: (r.model_note as string | null) ?? null,
    extractMs: r.extract_ms == null ? null : Number(r.extract_ms),
    verification: jsonValue<VerificationSummary | null>(r.verification, null),
  };
}

function toVerifyDraft(d: DraftClaim): VerifyDraft {
  return {
    entity: d.entity,
    attribute: d.attribute,
    value: d.value,
    statement: d.statement,
    citations: d.citations.map((c) => ({ segment_id: c.segmentId, quote: c.quote })),
    batchId: d.batchId,
    batchSegmentIds: d.batchSegmentIds,
    origin: d.origin,
  };
}

function droppedRoleSet(d: DroppedDraft, segsById: Map<string, Segment>): RoleKey[] {
  for (const id of d.draft.batchSegmentIds ?? []) {
    const s = segsById.get(id);
    if (s) return [...s.roleSet];
  }
  for (const c of d.draft.citations ?? []) {
    const s = segsById.get(c.segment_id);
    if (s) return [...s.roleSet];
  }
  return [];
}

const EVENT_FIELDS = ["trust", "state", "stateNote", "supersededBy", "supportCheck", "importance", "tier"] as const;

/** Verify the stored drafts, apply the rules and write the claim projection plus its events. */
export async function verify(ws: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const t0 = Date.now();
  const sql = db();
  const pack = attestPack(await getWorkspacePack(ws));
  let stored = await getExtraction(ws);
  if (!stored) {
    await reconstruct(ws);
    stored = await getExtraction(ws);
  }
  const drafts = stored?.drafts ?? [];
  const segments = await loadSegments(ws);
  const segsById = new Map(segments.map((s) => [s.id, s]));

  // 1. Citations: accepted / exact / trust, role set intersection.
  const vr = verifyDrafts(drafts.map(toVerifyDraft), segsById, pack, ws);
  const labels = new Map<string, string>();
  for (const d of drafts) if (d.entityRaw && !labels.has(d.entity)) labels.set(d.entity, d.entityRaw);
  const packKeys = new Set((pack.entities ?? []).map((e) => e.key));
  let claims: Claim[] = vr.claims.map((c) =>
    packKeys.has(c.entity) || c.entity === OTHER_ENTITY ? c : { ...c, entityLabel: labels.get(c.entity) ?? c.entityLabel },
  );
  claims = claims.map((c) => (c.entity === OTHER_ENTITY ? { ...c, entityLabel: "Other" } : c));

  // 2. Keep review work: review, note and an edited statement survive a re-run.
  const existingRows = (await sql`SELECT * FROM claims WHERE workspace_id = ${ws}`).map(toClaim);
  const existing = new Map(existingRows.map((c) => [c.id, c]));
  claims = claims.map((c) => {
    const prev = existing.get(c.id);
    if (!prev) return c;
    return {
      ...c,
      review: prev.review,
      reviewNote: prev.reviewNote,
      statement: prev.review === "edited" ? prev.statement : c.statement,
    };
  });

  // 3. Support check (model; can only lower trust). Cache-only when the endpoint is down.
  let supportNote: string | null = null;
  let supportChecked = 0;
  let supportLowered = 0;
  if (opts.support !== false && claims.some((c) => c.origin === "extracted")) {
    const up = opts.call ? true : await modelAvailable();
    const stats = newStats();
    const call = opts.call ?? attestModelCall({ cacheOnly: !up, stats });
    const sr = await supportCheck(claims, segsById, call);
    claims = sr.claims;
    supportChecked = sr.checked.length;
    supportLowered = sr.downgraded.length;
    const failed = sr.failures.reduce((n, f) => n + f.claimIds.length, 0);
    supportNote = !up && supportChecked === 0
      ? "Support check skipped: model unavailable."
      : failed
        ? `Support check: ${supportChecked} checked, ${failed} not checked (${sr.failures[0]?.error.slice(0, 100)}).`
        : `Support check: ${supportChecked} checked, ${supportLowered} lowered.`;
  } else if (opts.support === false) {
    supportNote = "Support check off.";
  }
  // A verdict from an earlier run still applies when this run could not check the claim.
  const checkedNow = new Set(claims.filter((c) => c.supportCheck).map((c) => c.id));
  claims = claims.map((c) => {
    const prev = existing.get(c.id);
    if (checkedNow.has(c.id) || !prev?.supportCheck) return c;
    const trust = prev.supportCheck === "no" ? weakerTrust(c.trust, "inferred") : c.trust;
    return { ...c, supportCheck: prev.supportCheck, trust };
  });

  // 4. Claims Attest did not derive from the record (a leaver's answer, a successor finding, a
  //    neighbour's answer, a trace) are written by other modules and are never re-produced by
  //    extraction. They are carried over with their content. Answers and findings take part in
  //    the rules; second-hand answers and traces stay outside them (see ./core/origins).
  const produced = new Set(claims.map((c) => c.id));
  const carried = existingRows.filter((c) => isCarriedOrigin(c.origin) && !produced.has(c.id) && c.state !== "dropped");
  //    A finding the approver has not let in yet moves nothing: it stays out of the rules.
  const answers = carried.filter((c) => takesPartInRules(c.origin) && !isUndecidedFinding(c));

  // 5. Rules: supersession / conflicts, corroboration, importance and tier.
  const entityKinds = await entityKindsFor(ws, pack);
  const ruled = applyRules([...claims, ...answers], pack, {
    segmentsById: segsById,
    entityKinds,
  });
  // A claim that cites a segment the content classifier marked is tier C, whatever its role set.
  const marked = (c: Claim) => c.citations.some((x) => x.accepted && (segsById.get(x.segmentId)?.sensitivity?.length ?? 0) > 0);
  const finalClaims = ruled.claims.map((c) => (c.tier !== "C" && marked(c) ? { ...c, tier: "C" as const } : c));
  // Flag visibility: a conflict or supersession with a side a role cannot read hides every side from it.
  const flags = flagRoleSets(finalClaims, ruled.firings);
  const firingByOlder = new Map(ruled.firings.map((f) => [f.olderId, f]));
  const firingByNewer = new Map(ruled.firings.filter((f) => f.rule >= 3).map((f) => [f.newerId, f]));

  // 6. Record claims that an earlier run produced but this one did not: dropped, never deleted.
  //    Only origins Attest owns can go stale; a carried claim is never dropped here.
  const finalIds = new Set(finalClaims.map((c) => c.id));
  const stale = existingRows
    .filter((c) => !finalIds.has(c.id) && isRecordOrigin(c.origin) && c.state !== "dropped")
    .map((c) => ({ ...c, state: "dropped" as const, stateNote: "Dropped: the latest extraction no longer finds this claim", supersededBy: null }));

  // 7. Write the projection (review fields untouched) and one event per change.
  const toWrite = [...finalClaims, ...stale];
  const rows = toWrite.map((c) => ({ ...claimRow(c, sourceIdsOf(c, segsById)), flag_role_set: flags.get(c.id) ?? null }));
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await sql`
      INSERT INTO claims ${sql(chunk)}
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        entity = EXCLUDED.entity, entity_label = EXCLUDED.entity_label, attribute = EXCLUDED.attribute,
        value = EXCLUDED.value,
        statement = CASE WHEN claims.review = 'edited' THEN claims.statement ELSE EXCLUDED.statement END,
        citations = EXCLUDED.citations, trust = EXCLUDED.trust, state = EXCLUDED.state,
        state_note = EXCLUDED.state_note, superseded_by = EXCLUDED.superseded_by, role_set = EXCLUDED.role_set,
        valid_from = EXCLUDED.valid_from, author_id = EXCLUDED.author_id, source_kinds = EXCLUDED.source_kinds,
        importance = EXCLUDED.importance, tier = EXCLUDED.tier, origin = EXCLUDED.origin,
        support_check = EXCLUDED.support_check, source_ids = EXCLUDED.source_ids,
        flag_role_set = EXCLUDED.flag_role_set, updated_at = now()`;
  }

  const events: { workspace_id: string; claim_id: string; event: string; data: string; actor: string }[] = [];
  const push = (claimIdV: string, event: string, data: Record<string, unknown>) =>
    events.push({ workspace_id: ws, claim_id: claimIdV, event, data: JSON.stringify(data), actor: "system" });
  for (const c of toWrite) {
    const prev = existing.get(c.id);
    if (!prev) {
      push(c.id, "created", { origin: c.origin, attribute: c.attribute, value: c.value, trust: c.trust, sourceKinds: c.sourceKinds });
    }
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const f of EVENT_FIELDS) {
      const before = prev ? prev[f] : null;
      if (prev && before === c[f]) continue;
      if (!prev && (f === "importance" || f === "tier")) continue;
      if (!prev && f === "state" && c.state === "active") continue;
      if (!prev && (f === "stateNote" || f === "supersededBy" || f === "supportCheck") && c[f] == null) continue;
      changed[f] = { from: before ?? null, to: c[f] ?? null };
    }
    if (prev && JSON.stringify(prev.citations) !== JSON.stringify(c.citations)) {
      changed.citations = { from: prev.citations.length, to: c.citations.length };
    }
    if (!Object.keys(changed).length) continue;
    const firing = firingByOlder.get(c.id) ?? firingByNewer.get(c.id);
    const event = changed.state
      ? c.state === "superseded" ? "superseded" : c.state === "conflicting" ? "conflicting" : c.state === "dropped" ? "dropped" : "reactivated"
      : changed.trust ? "verified" : changed.supportCheck ? "support_checked" : "updated";
    push(c.id, event, {
      changes: changed,
      note: c.stateNote,
      ...(firing && (changed.state || changed.supersededBy) ? { rule: firing.rule, olderId: firing.olderId, newerId: firing.newerId } : {}),
    });
  }
  for (let i = 0; i < events.length; i += 500) {
    await sql`INSERT INTO claim_events ${sql(events.slice(i, i + 500))}`;
  }

  // 8. Dropped drafts, role-scoped, counted per source.
  await sql`DELETE FROM attest_dropped WHERE workspace_id = ${ws}`;
  const droppedRows = vr.dropped.map((d, i) => ({
    workspace_id: ws,
    id: "drp_" + sha256Hex(`${i}|${d.draft.batchId}|${d.draft.entity}|${d.draft.attribute}|${d.draft.value}`).slice(0, 16),
    source_id: d.sourceId,
    source_kind: (segsById.get(d.draft.batchSegmentIds?.[0] ?? "")?.sourceKind ?? null) as SourceKind | null,
    reason: d.reason,
    entity: d.draft.entity,
    attribute: String(d.draft.attribute),
    value: d.draft.value,
    statement: d.draft.statement,
    citations: JSON.stringify(d.draft.citations ?? []),
    role_set: droppedRoleSet(d, segsById),
  }));
  for (let i = 0; i < droppedRows.length; i += 200) {
    await sql`INSERT INTO attest_dropped ${sql(droppedRows.slice(i, i + 200))} ON CONFLICT DO NOTHING`;
  }

  const live = finalClaims.filter((c) => c.state !== "dropped");
  const result: VerifyResult = {
    checked: finalClaims.length,
    fromRecord: live.filter((c) => c.trust === "from_record").length,
    corroborated: live.filter((c) => c.trust === "corroborated").length,
    inferred: live.filter((c) => c.trust === "inferred").length,
    dropped: vr.dropped.length + stale.length,
    draftsDropped: vr.dropped.length,
    claimsRetired: stale.length,
    superseded: live.filter((c) => c.state === "superseded").length,
    conflicting: live.filter((c) => c.state === "conflicting").length,
    firings: ruled.firings.length,
    supportChecked,
    supportLowered,
  };
  const summary: VerificationSummary = {
    result,
    firings: ruled.firings,
    droppedBySource: vr.droppedBySource,
    supportNote,
    ms: Date.now() - t0,
  };
  await sql`
    UPDATE attest_runs SET verification = ${JSON.stringify(summary)}::jsonb, verified_at = now()
    WHERE workspace_id = ${ws}`;
  return result;
}

/** A successor finding still waiting for the approver. It is evidence for nobody until approved. */
function isUndecidedFinding(c: Pick<Claim, "origin" | "review">): boolean {
  return c.origin === "successor_finding" && c.review === "pending";
}

const RULE_FIELDS = ["trust", "state", "stateNote", "supersededBy"] as const;

/** The label a person's own word starts with. Only a record that agrees can raise it. */
const PERSON_BASE_TRUST: Partial<Record<Claim["origin"], Claim["trust"]>> = {
  leaver_answer: "leaver_said",
  successor_finding: "successor_found",
};

/**
 * Re-run the rules (supersession, conflicts, corroboration, importance, tier) over the stored
 * claims. No extraction and no model call. Used when a successor finding is approved or
 * rejected: the claim set changed, the record did not.
 *
 * A person's word is put back to its own label first, so it reads "Corroborated" only while a
 * record still agrees and can never corroborate another person's word. Writes only the rows
 * whose rule fields changed, with one claim_events row each.
 */
export async function rerunRules(ws: string, actor: string): Promise<{ changed: number; firings: number }> {
  const sql = db();
  const pack = attestPack(await getWorkspacePack(ws));
  const stored = (await sql`SELECT * FROM claims WHERE workspace_id = ${ws} AND state <> 'dropped'`).map(toClaim);
  const byId = new Map(stored.map((c) => [c.id, c]));
  const input = stored
    .filter((c) => (isRecordOrigin(c.origin) || takesPartInRules(c.origin)) && !isUndecidedFinding(c))
    .map((c) => {
      const base = PERSON_BASE_TRUST[c.origin];
      return base && c.trust === "corroborated" ? { ...c, trust: base } : c;
    });
  // The rules look a segment up only through a claim's citations: read those, not every segment.
  const cited = input.flatMap((c) => c.citations.map((x) => x.segmentId));
  const segsById = new Map((await loadSegmentsByIds(ws, cited)).map((s) => [s.id, s]));
  const entityKinds = await entityKindsFor(ws, pack);
  const ruled = applyRules(input, pack, { segmentsById: segsById, entityKinds });
  const firingByOlder = new Map(ruled.firings.map((f) => [f.olderId, f]));
  const firingByNewer = new Map(ruled.firings.filter((f) => f.rule >= 3).map((f) => [f.newerId, f]));

  let changed = 0;
  for (const c of ruled.claims) {
    const prev = byId.get(c.id);
    if (!prev) continue;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    // Only a change of trust or state counts. Importance and tier follow such a change; on their
    // own they are left as the last full run set them, so a re-run never touches unrelated claims.
    for (const f of RULE_FIELDS) {
      if ((prev[f] ?? null) !== (c[f] ?? null)) changes[f] = { from: prev[f] ?? null, to: c[f] ?? null };
    }
    if (!Object.keys(changes).length) continue;
    for (const f of ["importance", "tier"] as const) {
      if (prev[f] !== c[f]) changes[f] = { from: prev[f], to: c[f] };
    }
    changed++;
    const firing = firingByOlder.get(c.id) ?? firingByNewer.get(c.id);
    const event = changes.state
      ? c.state === "superseded" ? "superseded" : c.state === "conflicting" ? "conflicting" : "reactivated"
      : changes.trust ? "verified" : "updated";
    const data = {
      changes, note: c.stateNote, trigger: "rules re-run",
      ...(firing && (changes.state || changes.supersededBy) ? { rule: firing.rule, olderId: firing.olderId, newerId: firing.newerId } : {}),
    };
    await sql.begin(async (tx) => {
      await tx`
        UPDATE claims SET trust = ${c.trust}, state = ${c.state}, state_note = ${c.stateNote},
          superseded_by = ${c.supersededBy}, importance = ${c.importance}, tier = ${c.tier}, updated_at = now()
        WHERE workspace_id = ${ws} AND id = ${c.id}`;
      await tx`INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
        VALUES (${ws}, ${c.id}, ${event}, ${JSON.stringify(data)}::jsonb, ${actor})`;
    });
  }
  return { changed, firings: ruled.firings.length };
}

function sourceIdsOf(c: Claim, segsById: Map<string, Segment>): string[] {
  const ids = new Set<string>();
  for (const cit of c.citations) {
    const s = segsById.get(cit.segmentId);
    if (s && cit.accepted) ids.add(s.sourceId);
  }
  return [...ids].sort();
}
