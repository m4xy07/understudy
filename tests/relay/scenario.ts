// A small compile scenario shared by the compile and canary tests.
import { compileHandover, type CompileInput } from "@/lib/relay/core/compile";
import type { Claim, ReadbackItem, RoleKey } from "@/lib/types";
import { makeClaim, makePlan, makeResp } from "./fixtures";
import { CLUB_APPROVER_LABEL } from "../helpers/club";

export const SECRET_TOKEN = "CANARY-7F3A";
export const OPEN_TOKEN = "CANARY-1111";
export const ALL_TOKENS = [SECRET_TOKEN, OPEN_TOKEN];

export function scenarioClaims(): Claim[] {
  return [
    makeClaim({ id: "c-owner", attribute: "owner", value: "Priya Nair", statement: "Priya owns firmware deploys." }),
    makeClaim({ id: "c-status", attribute: "status", value: "In progress", statement: "The deploy rework is in progress." }),
    makeClaim({ id: "c-deadline", attribute: "deadline", value: "28 Nov 2026", statement: "Deploy must work by 28 Nov 2026.", trust: "corroborated" }),
    makeClaim({ id: "c-risk", attribute: "risk", value: "brick", statement: "Flashing without the backup image bricks the controller." }),
    makeClaim({ id: "c-dep", attribute: "dependency", value: "lab booking", statement: "Deploys need the workshop lab booked." }),
    makeClaim({ id: "c-conf1", entity: "competition", entityLabel: "Regional competition", attribute: "location", value: "Hall A", statement: "Competition is in Hall A.", state: "conflicting", sourceKinds: ["slack"] }),
    makeClaim({ id: "c-conf2", entity: "competition", entityLabel: "Regional competition", attribute: "location", value: "Hall B", statement: "Competition is in Hall B.", state: "conflicting", sourceKinds: ["whatsapp"] }),
    makeClaim({ id: "c-access", attribute: "access", value: "ROBOT_SSH_KEY", statement: "Deploys use the ROBOT_SSH_KEY credential." }),
    makeClaim({ id: "c-dec1", entity: "controller", entityLabel: "Robot controller", attribute: "decision", value: "Teensy 4.1", statement: "Switched the controller to Teensy 4.1.", validFrom: "2026-10-05T12:00:00.000Z" }),
    makeClaim({ id: "c-reason1", entity: "controller", entityLabel: "Robot controller", attribute: "reason", value: "more pins", statement: "The old board ran out of pins.", validFrom: "2026-10-05T12:00:00.000Z" }),
    makeClaim({ id: "c-dec0", entity: "language", entityLabel: "Firmware language", attribute: "decision", value: "C++", statement: "Firmware stays in C++.", validFrom: "2026-09-01T08:00:00.000Z" }),
    makeClaim({ id: "c-edit", attribute: "procedure", value: "make flash-safe", statement: "Flash with make flash-safe.", review: "edited", trust: "inferred" }),
    // Restricted: treasurer and president only. Must never render for tech_lead.
    makeClaim({
      id: "c-secret", entity: "sponsor", entityLabel: `Sponsor contract ${SECRET_TOKEN}`, attribute: "deadline",
      value: "1 Dec 2026", statement: `Sponsor renewal ${SECRET_TOKEN} due 1 Dec 2026.`, roleSet: ["president", "treasurer"],
    }),
  ];
}

export const readbackItems: ReadbackItem[] = [
  { key: "competition_date", label: "Competition date", type: "date", expectedClaimId: "c-deadline" },
  { key: "deploy_command", label: "Deploy command", type: "command", expectedClaimId: "c-edit" },
  { key: "sponsor_deadline", label: "Sponsor deadline", type: "date", expectedClaimId: "c-secret" },
];

export function scenarioInput(role: RoleKey, claims: Claim[] = scenarioClaims()): CompileInput {
  return {
    role,
    roleLabel: role === "tech_lead" ? "Incoming tech lead" : role,
    approverLabel: CLUB_APPROVER_LABEL,
    snapshot: {
      version: 2,
      hash: "a".repeat(64),
      approvedAt: "2026-11-20T10:00:00.000Z",
      openBlocking: 2,
      releaseLabel: "Released with 2 open blocking gaps",
    },
    visibleClaims: claims,
    withheldCounts: { status: 0, summary: 2, actions: 1, risks: 0, timeline: 1 },
    scores: { b: 1, c: 0.91, k: 0.5 },
    provisional: true,
    plan: [
      makePlan({ responsibilityId: "r1", checkKey: "rollback", dueDate: "2026-11-30" }),
      makePlan({ responsibilityId: "r2", checkKey: "contact_person", owner: "Treasurer", riskNote: `Sponsor ${SECRET_TOKEN} lapses` }),
    ],
    responsibilities: [
      makeResp({ id: "r1", key: "R01", title: "Deploy firmware to the robot", entities: ["firmware-deploy"] }),
      makeResp({ id: "r2", key: "R02", title: `Renew sponsor contract ${SECRET_TOKEN}`, entities: ["sponsor"], kind: "external_relationship" }),
      makeResp({ id: "r3", key: "R03", title: "Book the workshop lab each term", entities: ["lab-booking"], origin: "role_template", kind: "recurring_obligation" }),
    ],
    readbackItems,
    checkLabels: { rollback: "Rollback" },
  };
}

export function scenarioDoc(role: RoleKey = "tech_lead") {
  return compileHandover(scenarioInput(role));
}
