// One write path for a person's answer (the leaver's, or a neighbour's during recovery):
// mask, then store the source row, the answer segment, the contacts, the claim and its event.
// Database glue only; what the claim says and who may see it is decided by the caller.
import type { TransactionSql } from "postgres";
import { db } from "@/lib/db/client";
import { maskText } from "@/lib/tether/mask";
import type { NarrowResult } from "@/lib/tether/sensitivity";
import { segmentSensitivityFields } from "@/lib/tether/visibility";
import type { Claim, RoleKey } from "@/lib/types";
import type { AnswerSegment } from "./core/questions";

export interface MaskedAnswer {
  text: string;
  secrets: number;
  contacts: { token: string; kind: "email" | "phone"; valueEnc: string }[];
}

/** Mask an answer before storage (Tether). Contact placeholders get workspace-unique numbers. */
export async function maskAnswer(ws: string, text: string): Promise<MaskedAnswer> {
  const masked = maskText(text, { contactsKey: process.env.CONTACTS_KEY ?? "", people: null });
  let maskedText = masked.text;
  const contacts: MaskedAnswer["contacts"] = [];
  if (masked.contacts.length) {
    const [{ n }] = await db()`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = ${ws}`;
    const renum = new Map<string, string>();
    for (const c of masked.contacts) {
      if (!renum.has(c.token)) renum.set(c.token, `[CONTACT:c-${9000 + Number(n) + renum.size + 1}]`);
      contacts.push({ token: renum.get(c.token)!, kind: c.kind, valueEnc: c.valueEnc });
    }
    for (const [from, to] of renum) maskedText = maskedText.split(from).join(to);
  }
  return { text: maskedText, secrets: masked.secrets, contacts };
}

export interface PersistAnswerParts {
  /** The answers source row (created on first use). */
  source: { id: string; name: string; roleSet: RoleKey[] };
  segment: AnswerSegment;
  claim: Claim;
  masked: MaskedAnswer;
  /** Roles that may resolve a contact placeholder in this answer. */
  contactRoles: RoleKey[];
  /**
   * The sensitivity decision for the answer text (narrowTypedText). The caller has already put
   * its role set on the claim; the fields are stored on the segment row.
   */
  sensitivity?: NarrowResult | null;
  /** Stored as the claim's "created" event. */
  event: Record<string, unknown>;
  actor: string;
}

/**
 * Store an answer inside the caller's transaction. Idempotent: the segment and claim ids are
 * deterministic, so a second submit of the same answer inserts nothing. Returns whether the
 * claim row was new.
 */
export async function persistAnswer(tx: TransactionSql, ws: string, p: PersistAnswerParts): Promise<boolean> {
  const { segment, claim } = p;
  const sens = segmentSensitivityFields(p.sensitivity);
  await tx`
    INSERT INTO sources (workspace_id, id, kind, name, role_set, origin)
    VALUES (${ws}, ${p.source.id}, 'interview', ${p.source.name}, ${p.source.roleSet}::text[], 'interview')
    ON CONFLICT (workspace_id, id) DO NOTHING`;
  const seg = await tx`
    INSERT INTO segments (workspace_id, id, version, source_id, source_kind, kind, ts, author_id, thread, position, text, text_hash, role_set, meta,
      sensitivity, sensitivity_stage, sensitivity_reason, role_set_original, classifier_version)
    VALUES (${ws}, ${segment.id}, 1, ${p.source.id}, 'interview', 'answer', ${segment.ts}, ${segment.authorId}, ${segment.thread}, 0,
      ${segment.text}, ${segment.textHash}, ${claim.roleSet}::text[], ${JSON.stringify(segment.meta)}::jsonb,
      ${sens.sensitivity}::text[], ${sens.stage}, ${sens.reason}, ${sens.roleSetOriginal}::text[], ${sens.classifierVersion})
    ON CONFLICT DO NOTHING RETURNING id`;
  if (seg.length > 0) {
    await tx`UPDATE sources SET segment_count = segment_count + 1, masked_secrets = masked_secrets + ${p.masked.secrets},
      masked_contacts = masked_contacts + ${p.masked.contacts.length} WHERE workspace_id = ${ws} AND id = ${p.source.id}`;
  }
  for (const c of p.masked.contacts) {
    await tx`
      INSERT INTO contacts (workspace_id, token, kind, person_id, value_enc, role_set, source_id)
      VALUES (${ws}, ${c.token}, ${c.kind}, ${null}, ${c.valueEnc}, ${p.contactRoles}::text[], ${p.source.id})
      ON CONFLICT DO NOTHING`;
  }
  const inserted = await tx`
    INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, state,
      role_set, valid_from, author_id, source_kinds, importance, tier, review, origin, source_ids)
    VALUES (${ws}, ${claim.id}, ${claim.entity}, ${claim.entityLabel}, ${claim.attribute}, ${claim.value}, ${claim.statement},
      ${JSON.stringify(claim.citations)}::jsonb, ${claim.trust}, 'active', ${claim.roleSet}::text[], ${claim.validFrom}, ${claim.authorId},
      ${["interview"]}::text[], ${claim.importance}, ${claim.tier}, 'pending', ${claim.origin}, ${[p.source.id]}::text[])
    ON CONFLICT (workspace_id, id) DO NOTHING RETURNING id`;
  if (inserted.length > 0) {
    await tx`INSERT INTO claim_events (workspace_id, claim_id, event, data, actor)
      VALUES (${ws}, ${claim.id}, 'created', ${JSON.stringify(p.event)}::jsonb, ${p.actor})`;
  }
  return inserted.length > 0;
}
