// The lists of the Evaluation page as one role may read them (pure).
// The answer key names entities and attributes; an item whose planted facts are all outside the
// viewing role's access is counted, never named. Headline numbers stay workspace totals.
import type { RoleKey } from "@/lib/types";
import type { EvalReport, GroundTruth } from "./core/evaluate";

export interface EvaluationLists {
  unmatched: EvalReport["unmatched"];
  hiddenUnmatched: number;
  falsePairs: EvalReport["falseConflicts"]["pairs"];
  perEntity: [string, EvalReport["perEntity"][string]][];
  hiddenEntities: number;
  supersessionsMissing: EvalReport["supersessions"]["missing"];
  hiddenSupersessions: number;
}

export function evaluationLists(
  report: EvalReport, groundTruth: GroundTruth, role: RoleKey, visibleClaimIds: ReadonlySet<string>,
): EvaluationLists {
  const mine = groundTruth.claims.filter((g) => (g.roleSet ?? []).includes(role));
  const myIds = new Set(mine.map((g) => g.id));
  const myEntities = new Set(mine.map((g) => g.entity));
  const myTopics = new Set(mine.map((g) => `${g.entity}|${g.attribute}`));

  const unmatched = report.unmatched.filter((u) => myIds.has(u.id));
  const all = Object.entries(report.perEntity).sort(([a], [b]) => a.localeCompare(b));
  const perEntity = all.filter(([entity]) => myEntities.has(entity));
  const supersessionsMissing = report.supersessions.missing.filter((s) => myTopics.has(`${s.entity}|${s.attribute}`));
  return {
    unmatched,
    hiddenUnmatched: report.unmatched.length - unmatched.length,
    falsePairs: report.falseConflicts.pairs.filter((p) => p.claimIds.every((cid) => visibleClaimIds.has(cid))),
    perEntity,
    hiddenEntities: all.length - perEntity.length,
    supersessionsMissing,
    hiddenSupersessions: report.supersessions.missing.length - supersessionsMissing.length,
  };
}
