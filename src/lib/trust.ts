// The trust ladder, written once. Every module that orders, labels or groups trust values
// imports from here (Attest support check, Lacuna scores, Relay labels, the chips).
// Exact label strings come from docs/ARCHITECTURE.md section 2.
import type { Trust } from "@/lib/types";

/**
 * Strongest first. "Successor found" sits just below "Leaver said": both are a named person's
 * direct word. It sits above "Second-hand" because the successor is the accountable owner and
 * the finding passes the approver before it counts.
 */
export const TRUST_ORDER: readonly Trust[] = [
  "from_record",
  "corroborated",
  "leaver_said",
  "successor_found",
  "second_hand",
  "inferred",
  "ranked_options",
];

/** Trust labels in words. Nothing a person said is ever labelled verified. */
export const TRUST_LABEL: Record<Trust, string> = {
  from_record: "From record",
  corroborated: "Corroborated",
  leaver_said: "Leaver said",
  successor_found: "Successor found",
  second_hand: "Second-hand",
  inferred: "Inferred",
  ranked_options: "Ranked options",
};

/** Trust that covers a check (raises C, can lower B): a record, or a named person's direct word. */
export const STRONG_TRUST: ReadonlySet<Trust> = new Set<Trust>(["from_record", "corroborated", "leaver_said", "successor_found"]);

/** Trust that counts toward K: the record only. A person's word never raises K. */
export const RECORD_TRUST: ReadonlySet<Trust> = new Set<Trust>(["from_record", "corroborated"]);

export function trustRank(t: Trust): number {
  const i = TRUST_ORDER.indexOf(t);
  return i === -1 ? TRUST_ORDER.length : i;
}

/** Strongest trust in the list, or null when empty. */
export function strongestTrust(trusts: readonly Trust[]): Trust | null {
  let best: Trust | null = null;
  for (const t of trusts) if (best === null || trustRank(t) < trustRank(best)) best = t;
  return best;
}

/** Weakest trust in the list (the conservative label for a line built from several claims). */
export function weakestTrust(trusts: readonly Trust[]): Trust | null {
  let worst: Trust | null = null;
  for (const t of trusts) if (worst === null || trustRank(t) > trustRank(worst)) worst = t;
  return worst;
}
