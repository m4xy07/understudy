// The slice of the setting pack (ARCHITECTURE section 1a) that Lacuna core reads.
// Structural on purpose: the full zod-validated pack from src/lib/pack/ satisfies it.
import type {
  Attribute, CheckDef, ResponsibilityKind, RoleKey, Trust, WTag,
} from "@/lib/types";

export interface PackEntity {
  key: string;
  label: string;
  aliases: string[];
}

/** A check as the pack may define it. Extra optional fields refine Lacuna's behaviour. */
export interface PackCheck {
  key: string;
  label: string;
  wTag: WTag;
  weight: 1 | 3 | 5;
  attributes: Attribute[];
  /** Optional: deterministic fallback only counts claims whose value/statement mentions one. */
  keywords?: string[];
  /** Optional gap-question templates; placeholders {resp} and {check}. */
  question?: { missing?: string; partial?: string };
}

export interface PackRoleTemplate {
  key: string;
  title: string;
  kind: ResponsibilityKind;
  entities: string[];
  dueDate?: string | null;
}

export interface LacunaPack {
  entities: PackEntity[];
  checklists?: Partial<Record<ResponsibilityKind, PackCheck[]>>;
  roleTemplates?: Partial<Record<RoleKey, PackRoleTemplate[]>>;
  footprint?: { repeatMin: number; distinctWeeksMin: number; ownershipShare: number; windowMonths: number };
  /** Optional kind overrides, keyed by entity key, "task-<id>" or raw card id. */
  kindOverrides?: Record<string, ResponsibilityKind>;
  leaverRole?: RoleKey;
  approverRole?: RoleKey;
  roles?: { key: RoleKey; label: string }[];
}

/** A check as Lacuna passes it around: the shared CheckDef plus optional pack refinements. */
export type LacunaCheck = CheckDef & Pick<PackCheck, "keywords" | "question">;

export const TRUST_ORDER: readonly Trust[] = [
  "from_record", "corroborated", "leaver_said", "second_hand", "inferred", "ranked_options",
];

export const TRUST_LABEL: Record<Trust, string> = {
  from_record: "From record",
  corroborated: "Corroborated",
  leaver_said: "Leaver said",
  second_hand: "Second-hand",
  inferred: "Inferred",
  ranked_options: "Ranked options",
};

/** Strongest trust in the list (section 2 order), or null when empty. */
export function strongestTrust(trusts: readonly Trust[]): Trust | null {
  let best: Trust | null = null;
  for (const t of trusts) {
    if (best === null || TRUST_ORDER.indexOf(t) < TRUST_ORDER.indexOf(best)) best = t;
  }
  return best;
}

export const STRONG_TRUST: ReadonlySet<Trust> = new Set<Trust>(["from_record", "corroborated", "leaver_said"]);
export const RECORD_TRUST: ReadonlySet<Trust> = new Set<Trust>(["from_record", "corroborated"]);

/** Key used for gaps, plan items and named owners: "<responsibilityId>|<checkKey>". */
export function gapKey(responsibilityId: string, checkKey: string): string {
  return `${responsibilityId}|${checkKey}`;
}
