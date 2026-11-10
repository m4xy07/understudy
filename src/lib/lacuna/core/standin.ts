// The stand-in successor (ARCHITECTURE section 4). The model only proposes; code decides coverage.
import { z } from "zod";
import type {
  Attribute, CheckDef, CheckResult, Claim, ClaimState, Coverage, Responsibility, RoleKey, Trust,
} from "@/lib/types";
import { norm } from "@/lib/text/norm";
import { checksFor } from "./checks";
import type { ModelCall } from "./model";
import { RECORD_TRUST, STRONG_TRUST, strongestTrust, type LacunaCheck, type LacunaPack } from "./pack";

/** Metadata for every claim in the workspace, from the metadata function (never the rows). */
export interface ClaimMeta {
  state: ClaimState;
  roleSet: readonly RoleKey[];
  attribute: Attribute;
  entity: string;
  trust: Trust;
}

/** The fields of a visible claim the stand-in needs. A full Claim satisfies it. */
export type VisibleClaim = Pick<Claim, "id" | "entity" | "attribute" | "value" | "statement" | "trust" | "state" | "roleSet">;

export type ClaimMetaIndex = ReadonlyMap<string, ClaimMeta> | Readonly<Record<string, ClaimMeta>>;

function metaOf(index: ClaimMetaIndex, id: string): ClaimMeta | undefined {
  if (index instanceof Map) return index.get(id);
  const rec = index as Readonly<Record<string, ClaimMeta>>;
  return Object.prototype.hasOwnProperty.call(rec, id) ? rec[id] : undefined;
}

function metaEntries(index: ClaimMetaIndex): [string, ClaimMeta][] {
  return index instanceof Map ? [...index.entries()] : Object.entries(index as Record<string, ClaimMeta>);
}

export const RESTRICTED_NOTE = "Evidence exists for other roles";
const WEAK_ONLY_NOTE = "Only inferred or second-hand evidence";
const CONFLICT_NOTE = "The record disagrees with itself";

// ---------- prompt and output schema ----------

export const StandinCheckSchema = z.object({
  check_key: z.string(),
  status: z.enum(["can_do", "partial", "cannot"]),
  claim_ids: z.array(z.string()),
  blocker: z.string(),
});

export const StandinOutputSchema = z.object({ checks: z.array(StandinCheckSchema) });

export type StandinOutput = z.infer<typeof StandinOutputSchema>;

export const STANDIN_JSON_SCHEMA_NAME = "standin_successor";

export const STANDIN_JSON_SCHEMA = z.toJSONSchema(StandinOutputSchema);

const STANDIN_SYSTEM =
  "You are the stand-in successor. You take over this responsibility tomorrow and must do it alone. " +
  "You may only use the claims listed. Never invent claim IDs. Reply with JSON only.";

export function formatClaimLine(c: VisibleClaim): string {
  const flag = c.state === "conflicting" ? ", conflicting" : "";
  return `[${c.id}] (${c.attribute}, ${c.trust}${flag}) ${c.statement}`;
}

export function buildStandinPrompt(
  resp: Pick<Responsibility, "key" | "title" | "kind">,
  checks: readonly CheckDef[],
  visibleClaims: readonly VisibleClaim[],
): { system: string; user: string } {
  const claimLines = visibleClaims.length > 0 ? visibleClaims.map(formatClaimLine).join("\n") : "(no claims)";
  const checkLines = checks
    .map((c) => `- ${c.key}: ${c.label} (${c.wTag}; answered by ${c.attributes.join(" or ")})`)
    .join("\n");
  const user = [
    `Responsibility ${resp.key}: ${resp.title} (${resp.kind.replace(/_/g, " ")})`,
    "",
    "You must do this tomorrow. For each check, cite claim IDs that let you do it, or say what stops you.",
    "",
    "Checks:",
    checkLines,
    "",
    "Claims you can see:",
    claimLines,
    "",
    'Return {"checks":[{"check_key":"...","status":"can_do"|"partial"|"cannot","claim_ids":["..."],"blocker":"..."}]} ' +
      "with one entry per check. blocker is empty when status is can_do.",
    "/no_think",
  ].join("\n");
  return { system: STANDIN_SYSTEM, user };
}

// ---------- shared helpers ----------

const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*`;
const DATE_RE = new RegExp(
  String.raw`\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}\b|\b${MONTH}\s+\d{1,2}\b|\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b`,
  "i",
);

/** Does the text name a date (ISO, "25 Nov", "Nov 25", "25/11")? */
export function namesDate(text: string): boolean {
  return DATE_RE.test(text);
}

/** True when the value is an ISO date strictly before `today` (day granularity). */
function isPastIsoDate(value: string, today: string | undefined): boolean {
  if (!today) return false;
  const m = /^\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(value);
  if (!m) return false;
  const t = Date.parse(today);
  if (Number.isNaN(t)) return false;
  return m[1] < new Date(t).toISOString().slice(0, 10);
}

function satisfies(
  claim: { attribute: Attribute; value?: string; statement?: string },
  check: LacunaCheck,
  today?: string,
): boolean {
  if (!check.attributes.includes(claim.attribute)) return false;
  if (check.needsDate && claim.value !== undefined) {
    if (!namesDate(claim.value)) return false;
    if (isPastIsoDate(claim.value, today)) return false;
  }
  if (!check.keywords || check.keywords.length === 0) return true;
  if (claim.value === undefined && claim.statement === undefined) return true; // metadata only: attribute decides
  const text = norm(`${claim.value ?? ""} ${claim.statement ?? ""}`);
  return check.keywords.some((k) => text.includes(norm(k)));
}

function isLive(state: ClaimState): boolean {
  return state === "active" || state === "conflicting";
}

/** Is there an active claim on the responsibility that satisfies the check but the role cannot see? */
function hiddenEvidence(
  resp: Pick<Responsibility, "entities">,
  check: LacunaCheck,
  role: RoleKey,
  allClaimsMeta: ClaimMetaIndex,
): boolean {
  for (const [, m] of metaEntries(allClaimsMeta)) {
    if (m.state !== "active") continue;
    if (!resp.entities.includes(m.entity)) continue;
    if (!check.attributes.includes(m.attribute)) continue;
    if (m.roleSet.includes(role)) continue;
    return true;
  }
  return false;
}

function visibleSatisfying(
  resp: Pick<Responsibility, "entities">,
  check: LacunaCheck,
  role: RoleKey,
  visibleClaims: readonly VisibleClaim[],
  today?: string,
): VisibleClaim[] {
  return visibleClaims.filter(
    (c) => isLive(c.state) && c.roleSet.includes(role) && resp.entities.includes(c.entity) && satisfies(c, check, today),
  );
}

function result(
  resp: Pick<Responsibility, "id">,
  check: CheckDef,
  coverage: Coverage,
  claims: readonly { id: string; trust: Trust }[],
  note: string,
): CheckResult {
  return {
    responsibilityId: resp.id,
    checkKey: check.key,
    coverage,
    claimIds: claims.map((c) => c.id),
    bestTrust: strongestTrust(claims.map((c) => c.trust)),
    note,
  };
}

// ---------- model path: evaluate the stand-in's answer ----------

export interface StandinContext {
  resp: Pick<Responsibility, "id" | "entities">;
  checks: readonly LacunaCheck[];
  role: RoleKey;
  visibleClaimsById: ReadonlyMap<string, VisibleClaim>;
  allClaimsMeta: ClaimMetaIndex;
  /** ISO date or date-time; dates before it do not satisfy a needsDate check. */
  today?: string;
}

export function evaluateStandin(output: StandinOutput, ctx: StandinContext): CheckResult[] {
  const visible = [...ctx.visibleClaimsById.values()];
  return ctx.checks.map((check) => {
    const answer = output.checks.find((a) => a.check_key === check.key);
    const blocker = answer?.blocker.trim() ?? "";

    // Code-side citation filter: exists, visible to this role, not superseded or dropped.
    const valid: VisibleClaim[] = [];
    for (const id of new Set(answer?.claim_ids ?? [])) {
      const claim = ctx.visibleClaimsById.get(id);
      if (!claim) continue;
      if (!claim.roleSet.includes(ctx.role)) continue;
      if (!isLive(claim.state)) continue;
      const meta = metaOf(ctx.allClaimsMeta, id);
      if (meta && (!isLive(meta.state) || !meta.roleSet.includes(ctx.role))) continue;
      valid.push(claim);
    }

    if (valid.length === 0) {
      const noVisibleEvidence = visibleSatisfying(ctx.resp, check, ctx.role, visible, ctx.today).length === 0;
      if (noVisibleEvidence && hiddenEvidence(ctx.resp, check, ctx.role, ctx.allClaimsMeta)) {
        return result(ctx.resp, check, "restricted", [], RESTRICTED_NOTE);
      }
      return result(ctx.resp, check, "missing", [], blocker || `Nothing on record for ${check.label.toLowerCase()}.`);
    }

    const active = valid.filter((c) => c.state === "active");
    if (active.length === 0) {
      return result(ctx.resp, check, "conflicting", valid, blocker || CONFLICT_NOTE);
    }
    const status = answer?.status ?? "cannot";
    if (status === "cannot") return result(ctx.resp, check, "missing", active, blocker || "The stand-in could not do this.");
    if (status === "partial") return result(ctx.resp, check, "partial", active, blocker || "Only part of this is on record.");
    // can_do: only strong evidence makes it covered; inferred or second-hand stays partial.
    const strong = active.filter((c) => STRONG_TRUST.has(c.trust));
    if (strong.length === 0) return result(ctx.resp, check, "partial", active, WEAK_ONLY_NOTE);
    return result(ctx.resp, check, "covered", active, "");
  });
}

// ---------- deterministic fallback ----------

export function deterministicStandin(
  resp: Pick<Responsibility, "id" | "entities">,
  checks: readonly LacunaCheck[],
  visibleClaims: readonly VisibleClaim[],
  allClaimsMeta: ClaimMetaIndex,
  role: RoleKey,
  today?: string,
): CheckResult[] {
  return checks.map((check) => {
    const hits = visibleSatisfying(resp, check, role, visibleClaims, today);
    const active = hits.filter((c) => c.state === "active");
    const strong = active.filter((c) => STRONG_TRUST.has(c.trust));
    if (strong.length > 0) return result(resp, check, "covered", strong, "");
    if (active.length > 0) return result(resp, check, "partial", active, WEAK_ONLY_NOTE);
    const conflicting = hits.filter((c) => c.state === "conflicting");
    if (conflicting.length > 0) return result(resp, check, "conflicting", conflicting, CONFLICT_NOTE);
    if (hiddenEvidence(resp, check, role, allClaimsMeta)) return result(resp, check, "restricted", [], RESTRICTED_NOTE);
    return result(resp, check, "missing", [], `Nothing on record for ${check.label.toLowerCase()}.`);
  });
}

// ---------- orchestration ----------

export interface RunStandinInput {
  resps: readonly Responsibility[];
  role: RoleKey;
  /** Claims read under withRole for this role. Superseded and dropped ones are ignored. */
  visibleClaims: readonly VisibleClaim[];
  allClaimsMeta: ClaimMetaIndex;
  pack?: LacunaPack | null;
  call?: ModelCall;
  /** ISO date or date-time; dates before it do not satisfy a needsDate check. */
  today?: string;
}

export interface RunStandinOutput {
  results: CheckResult[];
  /** True when at least one responsibility was judged from a model answer. */
  modelUsed: boolean;
  /** Model failures per responsibility key; those fell back to the deterministic path. */
  errors: { responsibilityKey: string; error: string }[];
}

export async function runStandin(input: RunStandinInput): Promise<RunStandinOutput> {
  const usable = input.visibleClaims.filter((c) => isLive(c.state) && c.roleSet.includes(input.role));
  const results: CheckResult[] = [];
  const errors: RunStandinOutput["errors"] = [];
  let modelUsed = false;

  for (const resp of input.resps) {
    const checks = checksFor(resp, input.pack);
    const relevant = usable.filter((c) => resp.entities.includes(c.entity));
    // No visible claims: the model could cite nothing, so the deterministic path decides alone.
    if (input.call && relevant.length > 0) {
      const { system, user } = buildStandinPrompt(resp, checks, relevant);
      let res: Awaited<ReturnType<ModelCall>>;
      try {
        res = await input.call({ system, user, schema: StandinOutputSchema, jsonSchemaName: STANDIN_JSON_SCHEMA_NAME });
      } catch (e) {
        res = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (res.ok) {
        const parsed = StandinOutputSchema.safeParse(res.data);
        if (parsed.success) {
          modelUsed = true;
          results.push(...evaluateStandin(parsed.data, {
            resp, checks, role: input.role,
            visibleClaimsById: new Map(relevant.map((c) => [c.id, c])),
            allClaimsMeta: input.allClaimsMeta,
            today: input.today,
          }));
          continue;
        }
        errors.push({ responsibilityKey: resp.key, error: "Model output did not match the schema" });
      } else {
        errors.push({ responsibilityKey: resp.key, error: res.error });
      }
    }
    results.push(...deterministicStandin(resp, checks, relevant, input.allClaimsMeta, input.role, input.today));
  }
  return { results, modelUsed, errors };
}

/** Does this result's best trust count toward K? */
export function isRecordBacked(r: Pick<CheckResult, "bestTrust">): boolean {
  return r.bestTrust !== null && RECORD_TRUST.has(r.bestTrust);
}
