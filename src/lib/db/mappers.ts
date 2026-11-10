// Row <-> type mappers between Postgres rows (snake_case) and src/lib/types.ts.
import type {
  Citation, Claim, ClaimState, Importance, Person, PlanItem, RejectedRow, Responsibility,
  ResponsibilityKind, ResponsibilityOrigin, ReviewState, ReviewTier, RoleKey, Segment, SegmentKind,
  Snapshot, Source, SourceKind, Attribute, Trust, TestRun, Scores, CheckResult, GapQuestion,
} from "@/lib/types";

// postgres.js returns timestamptz as Date, date as string (see client.ts), jsonb as parsed JSON.
type Row = Record<string, unknown>;

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return "";
}

function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}

function json<T>(v: unknown, fallback: T): T {
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

function arr<T = string>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export interface Workspace {
  id: string;
  name: string;
  kind: "demo" | "empty";
  packId: string;
  createdAt: string;
}

export function toWorkspace(r: Row): Workspace {
  return {
    id: String(r.id),
    name: String(r.name),
    kind: r.kind as Workspace["kind"],
    packId: String(r.pack_id ?? "club"),
    createdAt: iso(r.created_at),
  };
}

export interface SourceRow extends Source {
  origin: string;
}

export function toSource(r: Row): SourceRow {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    kind: r.kind as SourceKind,
    name: String(r.name),
    roleSet: arr<RoleKey>(r.role_set),
    segmentCount: Number(r.segment_count ?? 0),
    rejected: json<RejectedRow[]>(r.rejected, []),
    maskedSecrets: Number(r.masked_secrets ?? 0),
    maskedContacts: Number(r.masked_contacts ?? 0),
    importedAt: iso(r.imported_at),
    origin: String(r.origin ?? "demo"),
  };
}

export function toPerson(r: Row): Person {
  return {
    id: String(r.id),
    displayName: String(r.display_name),
    emailHmac: (r.email_hmac as string | null) ?? null,
    aliases: arr(r.aliases),
  };
}

export function toSegment(r: Row): Segment {
  return {
    id: String(r.id),
    sourceId: String(r.source_id),
    sourceKind: r.source_kind as SourceKind,
    kind: r.kind as SegmentKind,
    ts: iso(r.ts),
    authorId: (r.author_id as string | null) ?? null,
    thread: String(r.thread),
    position: Number(r.position ?? 0),
    text: String(r.text),
    textHash: String(r.text_hash),
    roleSet: arr<RoleKey>(r.role_set),
    version: Number(r.version ?? 1),
    meta: json<Record<string, unknown>>(r.meta, {}),
  };
}

export function toClaim(r: Row): Claim {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    entity: String(r.entity),
    entityLabel: String(r.entity_label),
    attribute: r.attribute as Attribute,
    value: String(r.value),
    statement: String(r.statement),
    citations: json<Citation[]>(r.citations, []),
    trust: r.trust as Trust,
    state: r.state as ClaimState,
    stateNote: (r.state_note as string | null) ?? null,
    supersededBy: (r.superseded_by as string | null) ?? null,
    roleSet: arr<RoleKey>(r.role_set),
    validFrom: iso(r.valid_from),
    authorId: (r.author_id as string | null) ?? null,
    sourceKinds: arr<SourceKind>(r.source_kinds),
    importance: r.importance as Importance,
    tier: r.tier as ReviewTier,
    review: r.review as ReviewState,
    reviewNote: (r.review_note as string | null) ?? null,
    origin: r.origin as Claim["origin"],
    supportCheck: (r.support_check as Claim["supportCheck"]) ?? null,
  };
}

/** Column object for INSERT ... ${sql(claimRow(c, ws))}. jsonb as a JSON string. */
export function claimRow(c: Claim, sourceIds: string[] = []) {
  return {
    workspace_id: c.workspaceId,
    id: c.id,
    entity: c.entity,
    entity_label: c.entityLabel,
    attribute: c.attribute,
    value: c.value,
    statement: c.statement,
    citations: JSON.stringify(c.citations),
    trust: c.trust,
    state: c.state,
    state_note: c.stateNote,
    superseded_by: c.supersededBy,
    role_set: c.roleSet,
    valid_from: c.validFrom,
    author_id: c.authorId,
    source_kinds: c.sourceKinds,
    importance: c.importance,
    tier: c.tier,
    review: c.review,
    review_note: c.reviewNote,
    origin: c.origin,
    support_check: c.supportCheck,
    source_ids: sourceIds,
  };
}

export function segmentRow(s: Segment, workspaceId: string) {
  return {
    workspace_id: workspaceId,
    id: s.id,
    version: s.version ?? 1,
    source_id: s.sourceId,
    source_kind: s.sourceKind,
    kind: s.kind,
    ts: s.ts,
    author_id: s.authorId,
    thread: s.thread,
    position: s.position,
    text: s.text,
    text_hash: s.textHash,
    role_set: s.roleSet,
    meta: JSON.stringify(s.meta ?? {}),
  };
}

export function toResponsibility(r: Row): Responsibility {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    key: String(r.key),
    title: String(r.title),
    kind: r.kind as ResponsibilityKind,
    entities: arr(r.entities),
    origin: r.origin as ResponsibilityOrigin,
    originDetail: String(r.origin_detail ?? ""),
    dueDate: (r.due_date as string | null) ?? null,
    confirmed: Boolean(r.confirmed),
  };
}

export function toTestRun(r: Row): TestRun {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    role: r.role as RoleKey,
    createdAt: iso(r.created_at),
    scores: json<Scores>(r.scores, { b: 0, c: 0, k: null }),
    results: json<CheckResult[]>(r.results, []),
    provisional: Boolean(r.provisional),
    modelUsed: Boolean(r.model_used),
  };
}

export function toGapQuestion(r: Row): GapQuestion {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    rank: Number(r.rank),
    responsibilityId: String(r.responsibility_id),
    checkKey: String(r.check_key),
    gapType: r.gap_type as GapQuestion["gapType"],
    text: String(r.text),
    score: Number(r.score),
    answeredClaimId: (r.answered_claim_id as string | null) ?? null,
  };
}

export function toPlanItem(r: Row): PlanItem {
  return {
    responsibilityId: String(r.responsibility_id),
    checkKey: String(r.check_key),
    owner: String(r.owner ?? ""),
    dueDate: (r.due_date as string | null) ?? "",
    riskNote: String(r.risk_note ?? ""),
  };
}

export function toSnapshot(r: Row): Snapshot {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    version: Number(r.version),
    hash: String(r.hash),
    approvedBy: r.approved_by as RoleKey,
    approvedAt: iso(r.approved_at),
    claimIds: arr(r.claim_ids),
    openBlocking: Number(r.open_blocking ?? 0),
    plan: json<PlanItem[]>(r.plan, []),
  };
}

export type RunStepKey = "connect" | "reconstruct" | "verify" | "test" | "ask";
export type RunStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface RunStep {
  key: RunStepKey;
  label: string;
  status: RunStepStatus;
  counts: Record<string, number>;
  note: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunStatus {
  id: string;
  workspaceId: string;
  status: "running" | "done" | "failed";
  steps: RunStep[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function toRun(r: Row): RunStatus {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    status: r.status as RunStatus["status"],
    steps: json<RunStep[]>(r.steps, []),
    error: (r.error as string | null) ?? null,
    startedAt: iso(r.started_at),
    finishedAt: isoOrNull(r.finished_at),
  };
}
