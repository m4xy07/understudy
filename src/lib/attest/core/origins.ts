// Claim origins and segment kinds that Attest must leave alone, written once.
//
// Attest produces two origins from the record: "extracted" (model) and "structured" (task board,
// calendar). Every other origin is written by another module: a leaver's answer, a neighbour's
// answer, a derived trace, a successor finding. verify() re-derives the record claims on every
// run; it must never drop, rewrite or re-label the others.
import type { ClaimOrigin, SegmentKind } from "@/lib/types";

/** Origins Attest derives from the record and owns: re-computed on every run. */
export const RECORD_ORIGINS: readonly ClaimOrigin[] = ["extracted", "structured"];

/** A person's own word, stored as a claim by the module that collected it. */
export const PERSON_ORIGINS: readonly ClaimOrigin[] = ["leaver_answer", "neighbour_answer", "successor_finding"];

/**
 * Origins that take part in the rules (supersession, conflicts, corroboration) next to record
 * claims. A neighbour's second-hand answer and a derived trace do not: they are weaker than any
 * record and must never supersede or conflict with one.
 */
export const RULE_ORIGINS: readonly ClaimOrigin[] = ["extracted", "structured", "leaver_answer", "successor_finding"];

export function isRecordOrigin(origin: ClaimOrigin): boolean {
  return RECORD_ORIGINS.includes(origin);
}

export function isPersonOrigin(origin: ClaimOrigin): boolean {
  return PERSON_ORIGINS.includes(origin);
}

/** True when verify() keeps the claim as it is instead of dropping it when extraction does not produce it. */
export function isCarriedOrigin(origin: ClaimOrigin): boolean {
  return !isRecordOrigin(origin);
}

export function takesPartInRules(origin: ClaimOrigin): boolean {
  return RULE_ORIGINS.includes(origin);
}

/** Segment kinds that hold a person's own words. Extraction never reads them. */
export const PERSON_SEGMENT_KINDS: readonly SegmentKind[] = ["answer", "finding"];

/** Kinds that produce claims deterministically (structured.ts), never through the model. */
export const DETERMINISTIC_KINDS: readonly SegmentKind[] = ["task", "event"];

/**
 * Kinds the model extraction skips: structured rows (read by code) and a person's own words.
 * Without the second group a pipeline re-run would send a leaver's answer to the model and
 * could store it again as a "From record" claim quoted from the answer itself.
 */
export const EXTRACTION_SKIP_KINDS: readonly SegmentKind[] = [...DETERMINISTIC_KINDS, ...PERSON_SEGMENT_KINDS];
