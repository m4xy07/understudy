// The slice of the setting pack (ARCHITECTURE section 1a) that Lacuna core reads.
// Structural on purpose: the full zod-validated pack from src/lib/pack/ satisfies it.
import type {
  Attribute, CheckDef, ResponsibilityKind, RoleKey, WTag,
} from "@/lib/types";

export interface PackEntity {
  key: string;
  label: string;
  aliases: string[];
  /** Optional: this entity is part of another one (e.g. a rollback is part of the deploy). */
  partOf?: string;
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
  /**
   * Optional: the check asks for an upcoming date (e.g. "Next due date"). Only claims whose value
   * names a date satisfy it ("once a term" does not), and a date before today does not.
   */
  needsDate?: boolean;
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
export type LacunaCheck = CheckDef & Pick<PackCheck, "keywords" | "question" | "needsDate">;

// The trust ladder is written once in src/lib/trust.ts.
export { TRUST_ORDER, TRUST_LABEL, STRONG_TRUST, RECORD_TRUST, strongestTrust } from "@/lib/trust";

/** Key used for gaps, plan items and named owners: "<responsibilityId>|<checkKey>". */
export function gapKey(responsibilityId: string, checkKey: string): string {
  return `${responsibilityId}|${checkKey}`;
}
