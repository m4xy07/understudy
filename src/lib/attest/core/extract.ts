// Claim extraction: plan batches (per thread, per identical role set) and run the
// injected model call over them. Contract: docs/ARCHITECTURE.md section 4 "Claims (Attest)".
// Pure module: no database, no network; the model call is injected.
import type { RoleKey, Segment, SegmentKind } from "@/lib/types";
import { norm, sha256Hex } from "@/lib/text/norm";
import { EXTRACTION_SKIP_KINDS } from "./origins";
import { buildSystemPrompt, buildUserPrompt, renderSegment, type AuthorLabel } from "./prompts";
import {
  EXTRACTION_JSON_SCHEMA_NAME,
  OTHER_ENTITY,
  buildExtractionJsonSchema,
  isAttribute,
  modelResponseSchema,
  rawClaimSchema,
  type DraftCitation,
  type DraftClaim,
  type ExtractionPack,
  type ModelCall,
  type OffListClaim,
} from "./schema";

/** About 8,000 tokens at ~3 chars per token. */
export const DEFAULT_MAX_CHARS = 24_000;
export const DEFAULT_CONCURRENCY = 4;
export { DETERMINISTIC_KINDS, EXTRACTION_SKIP_KINDS } from "./origins";

/**
 * Canonical role set: deduplicated, in the pack's role order (`order` = pack.roleOrder), so equal
 * sets compare equal. Keys the order does not list go last, alphabetically.
 */
export function canonicalRoleSet(roles: readonly RoleKey[], order: readonly RoleKey[]): RoleKey[] {
  const rank = (r: string) => {
    const i = order.indexOf(r);
    return i === -1 ? order.length : i;
  };
  return [...new Set(roles)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface PlannedBatch {
  id: string;
  sourceId: string;
  thread: string;
  roleSet: RoleKey[];
  segments: Segment[];         // ordered by time
  segmentIds: string[];
  chars: number;               // rendered size of the segment block
}

export interface PlanOptions {
  /** The pack's role order (pack.roleOrder): fixes how a role set is written in a batch id. */
  roleOrder: readonly RoleKey[];
  maxChars?: number;
  /** Default: EXTRACTION_SKIP_KINDS (structured rows, and a person's answers and findings). */
  skipKinds?: readonly SegmentKind[];
}

function timeOf(ts: string): number {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function compareSegments(a: Segment, b: Segment): number {
  return (
    timeOf(a.ts) - timeOf(b.ts) ||
    (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) ||
    a.position - b.position ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Group segments per (source, thread, identical role set), order by time, and split
 * each group at about `maxChars`, keeping reply chains (meta.replyTo) together where
 * they fit. A batch never mixes role sets. Task and event segments are skipped (code reads them),
 * and so are answer and finding segments: a person's own words are never sent to extraction.
 */
export function planBatches(segments: Segment[], opts: PlanOptions): PlannedBatch[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const skip = new Set<SegmentKind>(opts.skipKinds ?? EXTRACTION_SKIP_KINDS);

  // Deduplicate by id (keep the newest version).
  const byId = new Map<string, Segment>();
  for (const s of segments) {
    if (skip.has(s.kind)) continue;
    const prev = byId.get(s.id);
    if (!prev || s.version > prev.version) byId.set(s.id, s);
  }

  const groups = new Map<string, { sourceId: string; thread: string; roleSet: RoleKey[]; segs: Segment[] }>();
  for (const s of byId.values()) {
    const roleSet = canonicalRoleSet(s.roleSet, opts.roleOrder);
    const key = `${s.sourceId}\u0000${s.thread}\u0000${roleSet.join(",")}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { sourceId: s.sourceId, thread: s.thread, roleSet, segs: [] }));
    g.segs.push(s);
  }

  const ordered = [...groups.entries()]
    .map(([key, g]) => ({ key, ...g, segs: g.segs.sort(compareSegments) }))
    .sort((a, b) => compareSegments(a.segs[0], b.segs[0]) || (a.key < b.key ? -1 : 1));

  const batches: PlannedBatch[] = [];
  for (const g of ordered) {
    for (const segs of splitGroup(g.segs, maxChars)) {
      const segmentIds = segs.map((s) => s.id);
      const id =
        "batch_" +
        sha256Hex(`${g.roleSet.join(",")}|${g.sourceId}|${g.thread}|${segmentIds.join(",")}`).slice(0, 16);
      batches.push({
        id,
        sourceId: g.sourceId,
        thread: g.thread,
        roleSet: g.roleSet,
        segments: segs,
        segmentIds,
        chars: segs.reduce((n, s) => n + segmentChars(s), 0),
      });
    }
  }
  return batches;
}

function segmentChars(s: Segment): number {
  return renderSegment(s).length + 1;
}

/** Split one time-ordered group into batches, keeping reply chains together when they fit. */
function splitGroup(segs: Segment[], maxChars: number): Segment[][] {
  // Union-find over reply links inside the group.
  const index = new Map(segs.map((s, i) => [s.id, i]));
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  segs.forEach((s, i) => {
    const to = s.meta?.replyTo;
    const j = typeof to === "string" ? index.get(to) : undefined;
    if (j !== undefined) {
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const chains = new Map<number, Segment[]>();
  segs.forEach((s, i) => {
    const r = find(i);
    let c = chains.get(r);
    if (!c) chains.set(r, (c = []));
    c.push(s);
  });
  // Chains in order of their first segment (Map keeps insertion order = time order).

  const out: Segment[][] = [];
  let cur: Segment[] = [];
  let curChars = 0;
  const flush = () => {
    if (cur.length) out.push(cur.sort(compareSegments));
    cur = [];
    curChars = 0;
  };
  for (const chain of chains.values()) {
    const sizes = chain.map(segmentChars);
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total <= maxChars) {
      if (cur.length && curChars + total > maxChars) flush();
      cur.push(...chain);
      curChars += total;
      continue;
    }
    // A chain larger than one batch: split it in time order.
    flush();
    chain.forEach((s, k) => {
      if (cur.length && curChars + sizes[k] > maxChars) flush();
      cur.push(s);
      curChars += sizes[k];
    });
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Entity resolution: the model's entity must be a pack key or "other".

export function entityToken(x: string): string {
  return norm(x).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function makeEntityResolver(pack: ExtractionPack): (raw: string) => { entity: string; entityRaw: string | null } {
  const keys = new Set(pack.entities.map((e) => e.key));
  const lookup = new Map<string, Set<string>>();
  const add = (name: string, key: string) => {
    const t = entityToken(name);
    if (!t) return;
    let s = lookup.get(t);
    if (!s) lookup.set(t, (s = new Set()));
    s.add(key);
  };
  for (const e of pack.entities) {
    add(e.key, e.key);
    add(e.label, e.key);
    for (const a of e.aliases) add(a, e.key);
  }
  return (raw) => {
    if (keys.has(raw)) return { entity: raw, entityRaw: null };
    const t = entityToken(raw);
    if (t === OTHER_ENTITY) return { entity: OTHER_ENTITY, entityRaw: null };
    const hits = lookup.get(t);
    if (hits && hits.size === 1) return { entity: [...hits][0], entityRaw: raw };
    return { entity: OTHER_ENTITY, entityRaw: raw };
  };
}

// ---------------------------------------------------------------------------

export interface BatchReport {
  id: string;
  thread: string;
  roleSet: RoleKey[];
  segmentIds: string[];
  ok: boolean;
  error?: string;
  cached: boolean;
  claims: number;              // drafts kept from this batch
  offList: number;             // claims with an attribute outside the closed list
  malformed: number;           // claims that did not match the claim shape
}

export interface ExtractionResult {
  drafts: DraftClaim[];
  batches: BatchReport[];
  offList: number;
  offListClaims: OffListClaim[];
}

export interface ExtractOptions {
  /** The pack's role order (pack.roleOrder). */
  roleOrder: readonly RoleKey[];
  concurrency?: number;
  maxChars?: number;
  skipKinds?: readonly SegmentKind[];
  authorLabel?: AuthorLabel;
}

/**
 * Run the model over every planned batch (concurrency 4 by default). Failed batches
 * are reported, never thrown. Only content fields are read from the model: any labels
 * it adds (trust, verified, roles, state) are discarded by the schema.
 */
export async function extractClaims(
  segments: Segment[],
  pack: ExtractionPack,
  call: ModelCall,
  opts: ExtractOptions,
): Promise<ExtractionResult> {
  const batches = planBatches(segments, { roleOrder: opts.roleOrder, maxChars: opts.maxChars, skipKinds: opts.skipKinds });
  const system = buildSystemPrompt(pack);
  const jsonSchema = buildExtractionJsonSchema(pack.entities.map((e) => e.key));
  const resolveEntity = makeEntityResolver(pack);
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));

  const results = await mapPool(batches, concurrency, async (batch) => {
    const report: BatchReport = {
      id: batch.id,
      thread: batch.thread,
      roleSet: batch.roleSet,
      segmentIds: batch.segmentIds,
      ok: false,
      cached: false,
      claims: 0,
      offList: 0,
      malformed: 0,
    };
    const drafts: DraftClaim[] = [];
    const offList: OffListClaim[] = [];
    try {
      const res = await call({
        system,
        user: buildUserPrompt(batch, { authorLabel: opts.authorLabel }),
        schema: modelResponseSchema,
        jsonSchemaName: EXTRACTION_JSON_SCHEMA_NAME,
        jsonSchema,
      });
      if (!res.ok) {
        report.error = res.error || "model call failed";
        return { report, drafts, offList };
      }
      report.ok = true;
      report.cached = res.cached;
      for (const item of res.data.claims) {
        const parsed = rawClaimSchema.safeParse(item);
        if (!parsed.success) {
          report.malformed++;
          continue;
        }
        const c = parsed.data;
        const citations = cleanCitations(c.citations);
        if (!isAttribute(c.attribute)) {
          report.offList++;
          offList.push({
            batchId: batch.id,
            entity: c.entity,
            attribute: c.attribute,
            value: c.value,
            statement: c.statement,
            citations,
          });
          continue;
        }
        const { entity, entityRaw } = resolveEntity(c.entity);
        drafts.push({
          entity,
          entityRaw,
          attribute: c.attribute,
          value: c.value,
          statement: c.statement,
          citations,
          origin: "extracted",
          batchId: batch.id,
          batchSegmentIds: [...batch.segmentIds],
        });
      }
      report.claims = drafts.length;
    } catch (err) {
      report.ok = false;
      report.error = err instanceof Error ? err.message : String(err);
      drafts.length = 0;
      offList.length = 0;
    }
    return { report, drafts, offList };
  });

  const offListClaims = results.flatMap((r) => r.offList);
  return {
    drafts: results.flatMap((r) => r.drafts),
    batches: results.map((r) => r.report),
    offList: offListClaims.length,
    offListClaims,
  };
}

function cleanCitations(cs: { segment_id: string; quote?: string | null }[]): DraftCitation[] {
  const seen = new Set<string>();
  const out: DraftCitation[] = [];
  for (const c of cs) {
    const quote = typeof c.quote === "string" && c.quote.trim() ? c.quote : null;
    const k = `${c.segment_id}\u0000${quote ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ segmentId: c.segment_id, quote });
  }
  return out;
}

/** Map with at most `limit` tasks in flight; results keep input order. `fn` must not throw. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
