// Pure glue between the setting pack, Tether's footprint and Lacuna core. No database, no model.
import { MULTI_VALUED, type Attribute, type CheckResult, type Coverage, type Person, type Responsibility, type RoleKey, type Segment } from "@/lib/types";
import type { Pack } from "@/lib/pack";
import type { LacunaCheck, LacunaPack, PackCheck } from "./core/pack";
import type { ClaimMeta } from "./core/standin";
import type { FootprintCandidate } from "./core/inventory";
import { isOpenOrRecent, matchEntity, RECENT_DAYS } from "./core/inventory";

/** Attributes that name a person. A WHO check is only answered by one of these. */
const PERSON_ATTRIBUTES: readonly Attribute[] = ["owner", "contact"];

/**
 * The slice of the pack Lacuna core reads. One generic refinement: a WHO check needs a person,
 * so it is satisfied only by owner/contact claims (a credential NAME alone does not say who
 * holds it). Entities keep an optional `partOf` link.
 */
export function toLacunaPack(pack: Pack): LacunaPack {
  const checklists: LacunaPack["checklists"] = {};
  for (const [kind, list] of Object.entries(pack.checklists)) {
    checklists[kind as keyof NonNullable<LacunaPack["checklists"]>] = list.map((c): PackCheck => {
      const base = { ...(c as PackCheck), attributes: [...(c.attributes as Attribute[])] };
      if (c.wTag === "WHO") {
        const people = base.attributes.filter((a) => PERSON_ATTRIBUTES.includes(a));
        if (people.length > 0) base.attributes = people;
      }
      // A WHEN check answered only by a deadline asks for an actual upcoming date
      // ("once a term" is a cadence, not a next due date).
      if (c.wTag === "WHEN" && base.attributes.length === 1 && base.attributes[0] === "deadline") base.needsDate = true;
      return base;
    });
  }
  return {
    entities: pack.entities.map((e) => {
      const partOf = (e as Record<string, unknown>).partOf;
      return { key: e.key, label: e.label, aliases: [...e.aliases], ...(typeof partOf === "string" ? { partOf } : {}) };
    }),
    checklists,
    roleTemplates: pack.roleTemplates as LacunaPack["roleTemplates"],
    footprint: pack.footprint,
    kindOverrides: (pack as { kindOverrides?: LacunaPack["kindOverrides"] }).kindOverrides,
    leaverRole: pack.leaverRole,
    approverRole: pack.approverRole,
    roles: pack.roles.map((r) => ({ key: r.key, label: r.label })),
  };
}

/** First word of the leaver role label, e.g. "Priya (outgoing tech lead)" -> "Priya". */
export function leaverName(pack: Pick<Pack, "roles" | "leaverRole">): string {
  const label = pack.roles.find((r) => r.key === pack.leaverRole)?.label ?? "";
  return label.split(/[\s(,]/)[0]?.trim() ?? "";
}

function words(s: string): string[] {
  return s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Every person record that is the leaver: display name or any alias contains the leaver's name
 * as a word. Chat exports have no emails, so the same person can appear several times.
 */
export function leaverPersonIds(people: readonly Person[], name: string): string[] {
  const n = words(name)[0];
  if (!n) return [];
  return people
    .filter((p) => [p.displayName, ...p.aliases].some((x) => words(x).includes(n)))
    .map((p) => p.id);
}

const DAY_MS = 86_400_000;

/**
 * Drops footprint hits whose only evidence is finished work: every board card about the entity
 * is done (and not updated recently) and no evidence segment is newer than RECENT_DAYS.
 * Entities with no board card at all are kept (off-board duties are the point of the footprint).
 */
export function dropFinishedFootprint(
  candidates: readonly FootprintCandidate[],
  tasks: readonly Segment[],
  segmentsById: ReadonlyMap<string, Pick<Segment, "ts">>,
  pack: LacunaPack,
  today: string,
): { kept: FootprintCandidate[]; dropped: { entityKey: string; reason: string }[] } {
  const now = Date.parse(today);
  const cardsByEntity = new Map<string, Segment[]>();
  for (const t of tasks) {
    if (t.kind !== "task") continue;
    const labels = Array.isArray(t.meta.labels) ? (t.meta.labels as unknown[]).join(" ") : String(t.meta.labels ?? "");
    const e = matchEntity(`${String(t.meta.title ?? "")} ${labels}`, pack.entities);
    if (!e) continue;
    const list = cardsByEntity.get(e.key) ?? [];
    list.push(t);
    cardsByEntity.set(e.key, list);
  }
  const byEntity = new Map<string, FootprintCandidate[]>();
  for (const c of candidates) byEntity.set(c.entityKey, [...(byEntity.get(c.entityKey) ?? []), c]);

  const kept: FootprintCandidate[] = [];
  const dropped: { entityKey: string; reason: string }[] = [];
  for (const [entityKey, cands] of byEntity) {
    const cards = cardsByEntity.get(entityKey) ?? [];
    const allDone = cards.length > 0 && cards.every((c) => !isOpenOrRecent(c, today));
    const newest = Math.max(
      0,
      ...cands.flatMap((c) => c.evidenceSegmentIds).map((id) => Date.parse(segmentsById.get(id)?.ts ?? "")).filter(Number.isFinite),
    );
    const recent = Number.isFinite(now) && now - newest <= RECENT_DAYS * DAY_MS;
    if (allDone && !recent) {
      const ids = cards.map((c) => String(c.meta.id ?? c.id)).join(", ");
      dropped.push({ entityKey, reason: `finished work only (cards ${ids} done, no activity in ${RECENT_DAYS} days)` });
      continue;
    }
    kept.push(...cands);
  }
  return { kept, dropped };
}

const COVERAGE_RANK: Record<Coverage, number> = { covered: 3, partial: 2, conflicting: 1, missing: 0, restricted: 0 };

/**
 * Combine the stand-in's judgement with the deterministic reading of the record. The model may
 * only LOWER coverage (it judges whether the evidence is enough); facts of the record win:
 * conflicting and restricted come from claim states and metadata, never from the model.
 */
export function mergeJudgements(model: readonly CheckResult[], deterministic: readonly CheckResult[]): CheckResult[] {
  const byKey = new Map(model.map((r) => [`${r.responsibilityId}|${r.checkKey}`, r]));
  return deterministic.map((d) => {
    const m = byKey.get(`${d.responsibilityId}|${d.checkKey}`);
    if (!m) return d;
    if (d.coverage === "conflicting" || d.coverage === "restricted" || d.coverage === "missing") return d;
    if (COVERAGE_RANK[m.coverage] >= COVERAGE_RANK[d.coverage]) {
      // Same or more generous verdict: keep the record's reading, but prefer the model's citations
      // when they are a subset of the satisfying claims.
      const cited = m.claimIds.filter((id) => d.claimIds.includes(id));
      return cited.length > 0 && m.coverage === d.coverage ? { ...d, claimIds: cited } : d;
    }
    // The model says the evidence is not enough. Keep only citations that satisfy the check.
    const claimIds = m.claimIds.filter((id) => d.claimIds.includes(id));
    const coverage: Coverage = m.coverage === "conflicting" ? "missing" : m.coverage;
    return {
      ...d,
      coverage,
      claimIds: coverage === "missing" ? [] : claimIds.length > 0 ? claimIds : d.claimIds,
      bestTrust: coverage === "missing" ? null : d.bestTrust,
      note: m.note || d.note,
    };
  });
}

export const PARTLY_RESTRICTED_NOTE = "Part of this is visible only to other roles";

/**
 * A covered check whose attribute collects several values (reason, dependency, contact) is only
 * partly covered when more values exist that this role may not see (from metadata, never rows).
 */
export function markPartlyRestricted(
  results: readonly CheckResult[],
  resps: readonly Pick<Responsibility, "id" | "entities">[],
  checks: Record<string, readonly LacunaCheck[]>,
  meta: ReadonlyMap<string, ClaimMeta>,
  role: RoleKey,
): CheckResult[] {
  const byId = new Map(resps.map((r) => [r.id, r]));
  const hidden = [...meta.values()].filter((m) => m.state === "active" && !m.roleSet.includes(role) && MULTI_VALUED.includes(m.attribute));
  if (hidden.length === 0) return [...results];
  return results.map((r) => {
    if (r.coverage !== "covered") return r;
    const resp = byId.get(r.responsibilityId);
    const check = checks[r.responsibilityId]?.find((c) => c.key === r.checkKey);
    if (!resp || !check) return r;
    const more = hidden.some((m) => resp.entities.includes(m.entity) && check.attributes.includes(m.attribute));
    return more ? { ...r, coverage: "partial", note: PARTLY_RESTRICTED_NOTE } : r;
  });
}
