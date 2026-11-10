// Attest evaluation harness: scores claims against data/demo/ground_truth.json. Pure function.
//
// Matching: a ground-truth claim is matched by a claim with the same entity and attribute whose
// norm(value + " " + statement) contains every norm(keyword). Eligible states: active and
// superseded; conflicting too when (entity, attribute) is a planted conflict (those claims are
// supposed to be conflicting). Dropped claims never match.
import type { Attribute, Claim, RoleKey, Segment, SourceKind } from "@/lib/types";
import { norm } from "@/lib/text/norm";
import type { DroppedDraft } from "./verify";
import type { RuleFiring } from "./rules";

export interface GtClaim {
  id: string;
  entity: string;
  attribute: Attribute;
  value: string;
  keywords: string[];
  source?: { kind: SourceKind; path?: string; contains?: string };
  roleSet?: RoleKey[];
  check?: string | null;
}
export interface GtSupersession { entity: string; attribute: Attribute; old: string; new: string; rule?: number }
export interface GtConflict { entity: string; attribute: Attribute; values: string[] }
export interface GtRestricted { token: string; roleSet: RoleKey[]; where?: string }
export interface GtSecret { where?: string; type?: string; value: string }

export interface GroundTruth {
  claims: GtClaim[];
  supersessions?: GtSupersession[];
  conflicts?: GtConflict[];
  restricted?: GtRestricted[];
  secrets?: GtSecret[];
}

export interface Ratio { num: number; den: number; value: number | null }

export interface EvalInput {
  claims: Claim[];
  segmentsById: Map<string, Segment>;
  groundTruth: GroundTruth;
  dropped?: DroppedDraft[];   // verifier drops; their citations count in the citation pass rate
  firings?: RuleFiring[];     // when given, supersession rule numbers are checked too
}

export interface EvalReport {
  totals: { claims: number; active: number; superseded: number; conflicting: number; droppedDrafts: number };
  precision: Ratio;            // matched extracted / extracted (entity != "other", not dropped)
  recall: Ratio;               // matched gt / gt
  citationPassRate: Ratio;     // accepted exact citations / all citations
  fromRecordShare: Ratio;      // trust from_record / claims
  recordBackedShare: Ratio;    // trust from_record or corroborated / claims
  roleSetCorrect: Ratio;       // matched gt whose best claim has exactly the gt role set
  sourceCorrect: Ratio;        // matched gt whose claim cites a segment of the gt source kind containing gt.source.contains
  falseConflicts: { count: number; pairs: { entity: string; attribute: Attribute; values: [string, string]; claimIds: [string, string] }[] };
  plantedConflicts: { found: number; expected: number; missing: GtConflict[] };
  supersessions: { found: number; expected: number; ruleMatched: number | null; missing: GtSupersession[] };
  secretsLeaked: { count: number; hits: { claimId: string; field: string; type: string; where: string }[] };
  restrictedViolations: { count: number; hits: { claimId: string; token: string; extraRoles: RoleKey[] }[] };
  perEntity: Record<string, { expected: number; matched: number; recall: number | null }>;
  unmatched: { id: string; entity: string; attribute: Attribute; value: string }[];
}

const ratio = (num: number, den: number): Ratio => ({ num, den, value: den === 0 ? null : num / den });

/** Loose value equality for ground truth: one normalised value contains the other. */
export function valueMatches(claimValue: string, gtValue: string): boolean {
  const a = norm(claimValue);
  const b = norm(gtValue);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function matchesGt(claim: Claim, gt: GtClaim): boolean {
  if (claim.entity !== gt.entity || claim.attribute !== gt.attribute) return false;
  const hay = norm(`${claim.value} ${claim.statement}`);
  const kws = (gt.keywords ?? []).map(norm).filter(Boolean);
  if (kws.length === 0) return valueMatches(claim.value, gt.value);
  return kws.every((k) => hay.includes(k));
}

function claimTexts(c: Claim): [string, string][] {
  const out: [string, string][] = [
    ["value", c.value], ["statement", c.statement], ["entityLabel", c.entityLabel],
  ];
  if (c.stateNote) out.push(["stateNote", c.stateNote]);
  if (c.reviewNote) out.push(["reviewNote", c.reviewNote]);
  c.citations.forEach((ct, i) => { if (ct.quote) out.push([`citations[${i}].quote`, ct.quote]); });
  return out;
}

export function evaluate(input: EvalInput): EvalReport {
  const { claims, segmentsById, groundTruth: gt } = input;
  const live = claims.filter((c) => c.state !== "dropped");
  const plantedConflict = (c: Claim) =>
    (gt.conflicts ?? []).some((k) => k.entity === c.entity && k.attribute === c.attribute);
  const eligible = (c: Claim) =>
    c.state === "active" || c.state === "superseded" || (c.state === "conflicting" && plantedConflict(c));

  // Recall, per entity, role set and source checks.
  const matchedClaimIds = new Set<string>();
  const perEntity: EvalReport["perEntity"] = {};
  const unmatched: EvalReport["unmatched"] = [];
  let matchedGt = 0;
  let roleOk = 0;
  let roleDen = 0;
  let sourceOk = 0;
  let sourceDen = 0;
  for (const g of gt.claims) {
    const pe = (perEntity[g.entity] ??= { expected: 0, matched: 0, recall: null });
    pe.expected++;
    const hits = live.filter((c) => eligible(c) && matchesGt(c, g));
    for (const h of hits) matchedClaimIds.add(h.id);
    if (hits.length === 0) {
      unmatched.push({ id: g.id, entity: g.entity, attribute: g.attribute, value: g.value });
      continue;
    }
    matchedGt++;
    pe.matched++;
    if (g.roleSet) {
      roleDen++;
      const want = [...g.roleSet].sort().join(",");
      if (hits.some((h) => [...h.roleSet].sort().join(",") === want)) roleOk++;
    }
    if (g.source) {
      sourceDen++;
      const src = g.source;
      const ok = hits.some((h) =>
        h.citations.some((ct) => {
          if (!ct.accepted) return false;
          const seg = segmentsById.get(ct.segmentId);
          if (!seg || seg.sourceKind !== src.kind) return false;
          return !src.contains || norm(seg.text).includes(norm(src.contains));
        }),
      );
      if (ok) sourceOk++;
    }
  }
  for (const pe of Object.values(perEntity)) pe.recall = pe.expected === 0 ? null : pe.matched / pe.expected;

  // Precision over claims about known entities.
  const scored = live.filter((c) => c.entity !== "other");
  const correct = scored.filter((c) => matchedClaimIds.has(c.id) || (c.state === "conflicting" && plantedConflictValue(c, gt)));

  // Citations.
  let allCitations = 0;
  let passCitations = 0;
  for (const c of live) {
    for (const ct of c.citations) {
      allCitations++;
      if (ct.accepted && ct.exact) passCitations++;
    }
  }
  for (const d of input.dropped ?? []) allCitations += d.draft.citations?.length ?? 0;

  // Conflicts: every pair of conflicting claims on the same entity + attribute with different values.
  const conflicting = live.filter((c) => c.state === "conflicting");
  const falsePairs: EvalReport["falseConflicts"]["pairs"] = [];
  const foundPlanted = new Set<GtConflict>();
  for (let i = 0; i < conflicting.length; i++) {
    for (let j = i + 1; j < conflicting.length; j++) {
      const a = conflicting[i];
      const b = conflicting[j];
      if (a.entity !== b.entity || a.attribute !== b.attribute || norm(a.value) === norm(b.value)) continue;
      const planted = (gt.conflicts ?? []).find(
        (k) =>
          k.entity === a.entity && k.attribute === a.attribute &&
          k.values.some((v) => valueMatches(a.value, v)) && k.values.some((v) => valueMatches(b.value, v)),
      );
      if (planted) foundPlanted.add(planted);
      else falsePairs.push({ entity: a.entity, attribute: a.attribute, values: [a.value, b.value], claimIds: [a.id, b.id] });
    }
  }

  // Supersessions.
  const byId = new Map(claims.map((c) => [c.id, c]));
  const firingFor = new Map((input.firings ?? []).map((f) => [f.olderId, f]));
  let supFound = 0;
  let ruleMatched = 0;
  const supMissing: GtSupersession[] = [];
  for (const s of gt.supersessions ?? []) {
    const hit = claims.find((c) => {
      if (c.state !== "superseded" || c.entity !== s.entity || c.attribute !== s.attribute) return false;
      if (!valueMatches(c.value, s.old) || !c.supersededBy) return false;
      const winner = byId.get(c.supersededBy);
      return !!winner && valueMatches(winner.value, s.new);
    });
    if (!hit) { supMissing.push(s); continue; }
    supFound++;
    const f = firingFor.get(hit.id);
    if (f && s.rule != null && f.rule === s.rule) ruleMatched++;
  }

  // Secrets: raw values must never appear in any claim text.
  const secretHits: EvalReport["secretsLeaked"]["hits"] = [];
  for (const s of gt.secrets ?? []) {
    if (!s.value) continue;
    const raw = s.value;
    const normed = norm(raw);
    for (const c of claims) {
      for (const [field, text] of claimTexts(c)) {
        if (text.includes(raw) || (normed.length >= 6 && norm(text).includes(normed))) {
          secretHits.push({ claimId: c.id, field, type: s.type ?? "secret", where: s.where ?? "" });
        }
      }
    }
  }

  // Restricted tokens: a claim carrying a token must not be visible to roles outside its role set.
  const restrictedHits: EvalReport["restrictedViolations"]["hits"] = [];
  for (const r of gt.restricted ?? []) {
    for (const c of claims) {
      if (!claimTexts(c).some(([, t]) => t.includes(r.token))) continue;
      const extra = c.roleSet.filter((role) => !r.roleSet.includes(role));
      if (extra.length) restrictedHits.push({ claimId: c.id, token: r.token, extraRoles: extra });
    }
  }

  const n = live.length;
  return {
    totals: {
      claims: n,
      active: live.filter((c) => c.state === "active").length,
      superseded: live.filter((c) => c.state === "superseded").length,
      conflicting: conflicting.length,
      droppedDrafts: input.dropped?.length ?? 0,
    },
    precision: ratio(correct.length, scored.length),
    recall: ratio(matchedGt, gt.claims.length),
    citationPassRate: ratio(passCitations, allCitations),
    fromRecordShare: ratio(live.filter((c) => c.trust === "from_record").length, n),
    recordBackedShare: ratio(live.filter((c) => c.trust === "from_record" || c.trust === "corroborated").length, n),
    roleSetCorrect: ratio(roleOk, roleDen),
    sourceCorrect: ratio(sourceOk, sourceDen),
    falseConflicts: { count: falsePairs.length, pairs: falsePairs },
    plantedConflicts: {
      found: foundPlanted.size,
      expected: gt.conflicts?.length ?? 0,
      missing: (gt.conflicts ?? []).filter((k) => !foundPlanted.has(k)),
    },
    supersessions: {
      found: supFound,
      expected: gt.supersessions?.length ?? 0,
      ruleMatched: input.firings ? ruleMatched : null,
      missing: supMissing,
    },
    secretsLeaked: { count: secretHits.length, hits: secretHits },
    restrictedViolations: { count: restrictedHits.length, hits: restrictedHits },
    perEntity,
    unmatched,
  };
}

function plantedConflictValue(c: Claim, gt: GroundTruth): boolean {
  return (gt.conflicts ?? []).some(
    (k) => k.entity === c.entity && k.attribute === c.attribute && k.values.some((v) => valueMatches(c.value, v)),
  );
}

// ---------------------------------------------------------------------------------------------

const pct = (r: Ratio) => (r.value === null ? "n/a" : `${(r.value * 100).toFixed(1)}%`);
const frac = (r: Ratio) => `${pct(r)} (${r.num}/${r.den})`;

/** Markdown report. Never prints secret values; only where and what type they were. */
export function formatReport(r: EvalReport): string {
  const lines: string[] = [];
  lines.push("# Attest evaluation", "");
  lines.push(
    `Claims: ${r.totals.claims} (active ${r.totals.active}, superseded ${r.totals.superseded}, conflicting ${r.totals.conflicting}); dropped drafts: ${r.totals.droppedDrafts}`,
    "",
  );
  lines.push("| Metric | Value |", "|---|---|");
  lines.push(`| Precision | ${frac(r.precision)} |`);
  lines.push(`| Recall | ${frac(r.recall)} |`);
  lines.push(`| Citation pass rate (accepted exact quote) | ${frac(r.citationPassRate)} |`);
  lines.push(`| From record share | ${frac(r.fromRecordShare)} |`);
  lines.push(`| From record or corroborated | ${frac(r.recordBackedShare)} |`);
  lines.push(`| Role set correct (matched) | ${frac(r.roleSetCorrect)} |`);
  lines.push(`| Source correct (matched) | ${frac(r.sourceCorrect)} |`);
  lines.push(`| Supersessions found | ${r.supersessions.found}/${r.supersessions.expected}${r.supersessions.ruleMatched === null ? "" : ` (rule matched ${r.supersessions.ruleMatched})`} |`);
  lines.push(`| Planted conflicts found | ${r.plantedConflicts.found}/${r.plantedConflicts.expected} |`);
  lines.push(`| False conflicts | ${r.falseConflicts.count} |`);
  lines.push(`| Secrets leaked (must be 0) | ${r.secretsLeaked.count} |`);
  lines.push(`| Restricted token violations (must be 0) | ${r.restrictedViolations.count} |`);
  lines.push("");
  lines.push("## Recall per entity", "", "| Entity | Matched | Expected | Recall |", "|---|---|---|---|");
  for (const [entity, pe] of Object.entries(r.perEntity).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${entity} | ${pe.matched} | ${pe.expected} | ${pe.recall === null ? "n/a" : `${(pe.recall * 100).toFixed(0)}%`} |`);
  }
  if (r.unmatched.length) {
    lines.push("", "## Missed ground-truth claims", "");
    for (const u of r.unmatched) lines.push(`- ${u.id}: ${u.entity} / ${u.attribute} = ${u.value}`);
  }
  if (r.supersessions.missing.length) {
    lines.push("", "## Missed supersessions", "");
    for (const s of r.supersessions.missing) lines.push(`- ${s.entity} / ${s.attribute}: ${s.old} -> ${s.new}${s.rule ? ` (rule ${s.rule})` : ""}`);
  }
  if (r.falseConflicts.pairs.length) {
    lines.push("", "## False conflicts", "");
    for (const p of r.falseConflicts.pairs) lines.push(`- ${p.entity} / ${p.attribute}: "${p.values[0]}" vs "${p.values[1]}"`);
  }
  if (r.secretsLeaked.hits.length) {
    lines.push("", "## Secret leaks", "");
    for (const h of r.secretsLeaked.hits) lines.push(`- ${h.type} from ${h.where || "unknown"} in claim ${h.claimId} (${h.field})`);
  }
  if (r.restrictedViolations.hits.length) {
    lines.push("", "## Restricted token violations", "");
    for (const h of r.restrictedViolations.hits) lines.push(`- ${h.token} in claim ${h.claimId}, also visible to ${h.extraRoles.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}
