import type { Claim, PlanItem, Responsibility, RoleKey } from "@/lib/types";

export const ALL_ROLES: RoleKey[] = ["president", "tech_lead", "new_member", "treasurer", "leaver"];
export const AT = "2026-11-20T10:00:00.000Z";

export function makeClaim(overrides: Partial<Claim> & { id: string }): Claim {
  return {
    workspaceId: "ws-1",
    entity: "firmware-deploy",
    entityLabel: "Firmware deploy to the robot",
    attribute: "procedure",
    value: "Run make flash",
    statement: "Firmware is flashed with make flash.",
    citations: [{ segmentId: `seg_${overrides.id.padEnd(16, "0").slice(0, 16)}`, quote: "make flash", accepted: true, exact: true }],
    trust: "from_record",
    state: "active",
    stateNote: null,
    supersededBy: null,
    roleSet: [...ALL_ROLES],
    validFrom: "2026-10-01T09:00:00.000Z",
    authorId: "p-1",
    sourceKinds: ["github"],
    importance: "normal",
    tier: "B",
    review: "pending",
    reviewNote: null,
    origin: "extracted",
    supportCheck: null,
    ...overrides,
  };
}

export function makeResp(overrides: Partial<Responsibility> & { id: string; key: string }): Responsibility {
  return {
    workspaceId: "ws-1",
    title: "Deploy firmware to the robot",
    kind: "deploy_operate",
    entities: ["firmware-deploy"],
    origin: "task_board",
    originDetail: "card T-12",
    dueDate: null,
    confirmed: true,
    ...overrides,
  };
}

export function makePlan(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    responsibilityId: "r1",
    checkKey: "rollback",
    owner: "Arjun (tech lead)",
    dueDate: "2026-11-30",
    riskNote: "Robot cannot be restored if a flash fails",
    ...overrides,
  };
}
