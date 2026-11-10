// Typed checks per responsibility kind (ARCHITECTURE section 4, "Test and Ask").
// The pack's checklists win; these defaults mirror the contract exactly.
import type { CheckDef, Responsibility, ResponsibilityKind } from "@/lib/types";
import type { LacunaCheck, LacunaPack, PackCheck } from "./pack";

export const DEFAULT_CHECKLISTS: Record<ResponsibilityKind, PackCheck[]> = {
  deploy_operate: [
    { key: "access_path", label: "Access path", wTag: "WHERE", weight: 3, attributes: ["location", "access"] },
    { key: "steps", label: "Steps", wTag: "HOW", weight: 3, attributes: ["procedure"] },
    { key: "verify", label: "How to verify", wTag: "HOW", weight: 3, attributes: ["procedure"] },
    { key: "rollback", label: "Rollback", wTag: "HOW", weight: 5, attributes: ["procedure"] },
    { key: "credential_owner", label: "Credential owner", wTag: "WHO", weight: 5, attributes: ["access", "owner"] },
  ],
  external_relationship: [
    { key: "contact_person", label: "Contact person", wTag: "WHO", weight: 5, attributes: ["contact", "owner"] },
    { key: "last_interaction", label: "Last interaction", wTag: "WHEN", weight: 1, attributes: ["status"] },
    { key: "open_commitments", label: "Open commitments", wTag: "WHY", weight: 3, attributes: ["dependency", "decision", "status"] },
    { key: "next_date", label: "Next date", wTag: "WHEN", weight: 3, attributes: ["deadline"] },
  ],
  recurring_obligation: [
    { key: "cadence", label: "Cadence", wTag: "WHEN", weight: 3, attributes: ["deadline"] },
    { key: "next_due", label: "Next due date", wTag: "WHEN", weight: 5, attributes: ["deadline"] },
    { key: "how_to", label: "How to do it", wTag: "HOW", weight: 3, attributes: ["procedure"] },
    { key: "consequence", label: "Consequence if missed", wTag: "WHY", weight: 1, attributes: ["risk", "reason"] },
  ],
  open_decision: [
    { key: "current_state", label: "Current state", wTag: "WHERE", weight: 3, attributes: ["status", "decision"] },
    { key: "options", label: "Options considered", wTag: "WHY", weight: 1, attributes: ["decision", "reason"] },
    { key: "owner", label: "Owner", wTag: "WHO", weight: 5, attributes: ["owner"] },
    { key: "deadline", label: "Deadline", wTag: "WHEN", weight: 3, attributes: ["deadline"] },
  ],
  unfinished_work: [
    { key: "where_it_lives", label: "Where it lives", wTag: "WHERE", weight: 3, attributes: ["location"] },
    { key: "last_state", label: "Last state", wTag: "WHERE", weight: 3, attributes: ["status"] },
    { key: "next_step", label: "Next concrete step", wTag: "HOW", weight: 5, attributes: ["procedure", "dependency"] },
    { key: "reviewer", label: "Who reviews it", wTag: "WHO", weight: 1, attributes: ["owner", "contact"] },
  ],
};

export const KIND_ORDER: readonly ResponsibilityKind[] = [
  "deploy_operate", "external_relationship", "recurring_obligation", "open_decision", "unfinished_work",
];

function toCheck(p: PackCheck): LacunaCheck {
  const c: LacunaCheck = {
    key: p.key, label: p.label, wTag: p.wTag, weight: p.weight, attributes: [...p.attributes],
  };
  if (p.keywords && p.keywords.length > 0) c.keywords = [...p.keywords];
  if (p.question) c.question = { ...p.question };
  return c;
}

/** Checklist for one kind: the pack's list when it has one, else the contract default. */
export function checklistForKind(kind: ResponsibilityKind, pack?: LacunaPack | null): LacunaCheck[] {
  const fromPack = pack?.checklists?.[kind];
  const list = fromPack && fromPack.length > 0 ? fromPack : DEFAULT_CHECKLISTS[kind];
  return list.map(toCheck);
}

export function checksFor(resp: Pick<Responsibility, "kind">, pack?: LacunaPack | null): LacunaCheck[] {
  return checklistForKind(resp.kind, pack);
}

/** Checks keyed by responsibility id; the shape scores, questions and plan take. */
export function checksByResp(
  resps: readonly Pick<Responsibility, "id" | "kind">[],
  pack?: LacunaPack | null,
): Record<string, LacunaCheck[]> {
  const out: Record<string, LacunaCheck[]> = {};
  for (const r of resps) out[r.id] = checksFor(r, pack);
  return out;
}

export function isBlocking(check: Pick<CheckDef, "weight">): boolean {
  return check.weight === 5;
}

export function findCheck<T extends CheckDef>(
  checks: Record<string, readonly T[]>,
  responsibilityId: string,
  checkKey: string,
): T | undefined {
  return checks[responsibilityId]?.find((c) => c.key === checkKey);
}
