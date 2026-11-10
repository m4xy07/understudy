// Shared fixtures for Lacuna core tests. Not a test file (no .test.ts suffix).
import type { Claim, Responsibility, RoleKey, Segment, Trust, ClaimState, Attribute } from "@/lib/types";
import type { LacunaPack } from "@/lib/lacuna/core/pack";
import type { ClaimMeta } from "@/lib/lacuna/core/standin";

export const ALL_ROLES: RoleKey[] = ["president", "tech_lead", "new_member", "treasurer", "leaver"];

export const pack: LacunaPack = {
  entities: [
    { key: "firmware-deploy", label: "Firmware deploy to the robot", aliases: ["deploy", "flash", "firmware"] },
    { key: "lab-booking", label: "Workshop lab booking", aliases: ["lab", "workshop lab"] },
    { key: "sponsor-acme", label: "Acme sponsorship", aliases: ["acme"] },
    { key: "competition", label: "Regional competition", aliases: ["competition", "regionals"] },
  ],
  roleTemplates: {
    tech_lead: [
      { key: "R03", title: "Book the workshop lab each term", kind: "recurring_obligation", entities: ["lab-booking"] },
      { key: "R07", title: "Keep the parts inventory", kind: "unfinished_work", entities: ["parts-inventory"] },
    ],
    treasurer: [
      { key: "T01", title: "File the grant report", kind: "recurring_obligation", entities: ["grant-report"] },
    ],
  },
  footprint: { repeatMin: 3, distinctWeeksMin: 2, ownershipShare: 0.8, windowMonths: 6 },
};

export function task(meta: {
  id: string; title: string; status?: string; owner?: string; due?: string; labels?: string | string[]; updated_at?: string;
}): Segment {
  return {
    id: `seg_task_${meta.id}`,
    sourceId: "src_tasks",
    sourceKind: "tasks_csv",
    kind: "task",
    ts: meta.updated_at ?? "2026-10-01T00:00:00Z",
    authorId: "p-1",
    thread: "board",
    position: 0,
    text: meta.title,
    textHash: "x",
    roleSet: ALL_ROLES,
    version: 1,
    meta: { status: "open", owner: "Priya", due: "", labels: "", updated_at: "2026-10-01", ...meta },
  };
}

let claimSeq = 0;
export function claim(p: {
  id?: string; entity: string; attribute: Attribute; trust?: Trust; state?: ClaimState; roleSet?: RoleKey[];
  value?: string; statement?: string;
}): Claim {
  const id = p.id ?? `c${++claimSeq}`;
  const value = p.value ?? `${p.attribute} value ${id}`;
  return {
    id,
    workspaceId: "ws",
    entity: p.entity,
    entityLabel: p.entity,
    attribute: p.attribute,
    value,
    statement: p.statement ?? `${p.entity} ${p.attribute}: ${value}`,
    citations: [],
    trust: p.trust ?? "from_record",
    state: p.state ?? "active",
    stateNote: null,
    supersededBy: null,
    roleSet: p.roleSet ?? ALL_ROLES,
    validFrom: "2026-10-01T00:00:00Z",
    authorId: "p-1",
    sourceKinds: ["slack"],
    importance: "normal",
    tier: "B",
    review: "pending",
    reviewNote: null,
    origin: "extracted",
    supportCheck: null,
  };
}

export function metaIndex(claims: readonly Claim[]): Map<string, ClaimMeta> {
  return new Map(claims.map((c) => [c.id, {
    state: c.state, roleSet: c.roleSet, attribute: c.attribute, entity: c.entity, trust: c.trust,
  }]));
}

export function resp(p: Partial<Responsibility> & Pick<Responsibility, "id" | "kind" | "entities">): Responsibility {
  return {
    workspaceId: "ws",
    key: p.key ?? "R01",
    title: p.title ?? "Firmware deploy to the robot",
    origin: "task_board",
    originDetail: "Task board: card 1",
    dueDate: null,
    confirmed: false,
    ...p,
  };
}
