// Small hand-made fixtures for the Attest verifier / rules / evaluation tests.
import type { Attribute, Claim, RoleKey, Segment, SourceKind } from "@/lib/types";
import { norm, sha256Hex } from "@/lib/text/norm";
import type { AttestPack, DraftClaim } from "@/lib/attest/core/verify";
import { CLUB_RESTRICTED, CLUB_ROLE_ORDER } from "../../helpers/club";

export const ALL_ROLES: RoleKey[] = ["president", "tech_lead", "new_member", "treasurer", "leaver"];

const ATTRS: Attribute[] = [
  "owner", "status", "deadline", "location", "procedure", "access",
  "decision", "reason", "dependency", "contact", "risk",
];

const DEFAULT_AUTHORITY: Record<SourceKind, number> = {
  tasks_csv: 2, ics: 2, markdown: 2, slack: 1, whatsapp: 1, github: 2, interview: 1, finding: 1,
};

export const pack: AttestPack = {
  roleOrder: CLUB_ROLE_ORDER,
  restrictedAudience: CLUB_RESTRICTED,
  entities: [
    { key: "firmware-deploy", label: "Firmware deploy to the robot", aliases: ["deploy", "flash", "firmware"] },
    { key: "competition", label: "Regional robotics competition", aliases: ["regionals"] },
    { key: "lab-booking", label: "Workshop lab booking", aliases: ["lab"] },
    { key: "sponsor", label: "Sponsor relationship", aliases: ["sponsorship"] },
  ],
  sourceAuthority: Object.fromEntries(
    ATTRS.map((a) => [
      a,
      a === "deadline" || a === "status" || a === "owner"
        ? { ...DEFAULT_AUTHORITY, tasks_csv: 3, ics: 3 }
        : DEFAULT_AUTHORITY,
    ]),
  ),
  checklists: {
    deploy_operate: [
      { key: "access_path", weight: 3, attributes: ["location", "access"] },
      { key: "steps", weight: 3, attributes: ["procedure"] },
      { key: "rollback", weight: 5, attributes: ["procedure"] },
      { key: "credential_owner", weight: 5, attributes: ["owner", "access"] },
    ],
    recurring_obligation: [
      { key: "cadence", weight: 3, attributes: ["deadline"] },
      { key: "next_due", weight: 5, attributes: ["deadline"] },
      { key: "how", weight: 3, attributes: ["procedure"] },
      { key: "consequence", weight: 1, attributes: ["risk", "reason"] },
    ],
    external_relationship: [
      { key: "contact_person", weight: 5, attributes: ["contact", "owner"] },
      { key: "last_interaction", weight: 1, attributes: ["status"] },
      { key: "open_commitments", weight: 3, attributes: ["decision", "dependency"] },
      { key: "next_date", weight: 3, attributes: ["deadline"] },
    ],
  },
  roleTemplates: {
    tech_lead: [
      { key: "R01", kind: "deploy_operate", entities: ["firmware-deploy"] },
      { key: "R03", kind: "recurring_obligation", entities: ["lab-booking"] },
    ],
  },
};

let pos = 0;
export function seg(p: Partial<Segment> & { text: string }): Segment {
  const sourceKind = p.sourceKind ?? "slack";
  const ts = p.ts ?? "2026-10-01T10:00:00.000Z";
  const thread = p.thread ?? "#robot";
  const position = p.position ?? pos++;
  const id = p.id ?? "seg_" + sha256Hex(`${sourceKind}|${ts}|${thread}|${position}|${sha256Hex(norm(p.text))}`).slice(0, 16);
  return {
    id,
    sourceId: p.sourceId ?? `src_${sourceKind}`,
    sourceKind,
    kind: p.kind ?? "message",
    ts,
    authorId: p.authorId === undefined ? "p-1" : p.authorId,
    thread,
    position,
    text: p.text,
    textHash: sha256Hex(norm(p.text)),
    roleSet: p.roleSet ?? ALL_ROLES,
    version: 1,
    meta: p.meta ?? {},
  };
}

export function segMap(...segs: Segment[]): Map<string, Segment> {
  return new Map(segs.map((s) => [s.id, s]));
}

export function draft(p: Partial<DraftClaim> & { citations: DraftClaim["citations"] }): DraftClaim {
  return {
    entity: p.entity ?? "firmware-deploy",
    attribute: p.attribute ?? "procedure",
    value: p.value ?? "value",
    statement: p.statement ?? "A statement.",
    citations: p.citations,
    batchId: p.batchId ?? "b1",
    batchSegmentIds: p.batchSegmentIds ?? p.citations.map((c) => c.segment_id),
    origin: p.origin ?? "extracted",
  };
}

let n = 0;
/** A ready-made claim for rule tests (bypasses the verifier). */
export function claim(p: Partial<Claim> & { value: string }): Claim {
  n++;
  return {
    id: p.id ?? `clm_test${String(n).padStart(4, "0")}`,
    workspaceId: "ws",
    entity: p.entity ?? "competition",
    entityLabel: p.entityLabel ?? "Regional robotics competition",
    attribute: p.attribute ?? "deadline",
    value: p.value,
    statement: p.statement ?? `It is ${p.value}.`,
    citations: p.citations ?? [{ segmentId: `seg_x${n}`, quote: p.value, accepted: true, exact: true }],
    trust: p.trust ?? "from_record",
    state: p.state ?? "active",
    stateNote: p.stateNote ?? null,
    supersededBy: p.supersededBy ?? null,
    roleSet: p.roleSet ?? ALL_ROLES,
    validFrom: p.validFrom ?? "2026-10-01T10:00:00.000Z",
    authorId: p.authorId === undefined ? "p-1" : p.authorId,
    sourceKinds: p.sourceKinds ?? ["slack"],
    importance: p.importance ?? "normal",
    tier: p.tier ?? "B",
    review: p.review ?? "pending",
    reviewNote: p.reviewNote ?? null,
    origin: p.origin ?? "extracted",
    supportCheck: p.supportCheck ?? null,
  };
}
