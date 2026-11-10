// zod schema for the setting pack (docs/ARCHITECTURE.md section 1a).
// Objects are "loose": extra keys a module adds later are kept, never rejected.
import { z } from "zod";

export const RoleKeyZ = z.enum(["president", "tech_lead", "new_member", "treasurer", "leaver"]);
export const SourceKindZ = z.enum(["whatsapp", "slack", "github", "tasks_csv", "markdown", "ics", "interview"]);
export const AttributeZ = z.enum([
  "owner", "status", "deadline", "location", "procedure", "access",
  "decision", "reason", "dependency", "contact", "risk",
]);
export const ResponsibilityKindZ = z.enum([
  "deploy_operate", "external_relationship", "recurring_obligation", "open_decision", "unfinished_work",
]);
export const WTagZ = z.enum(["WHO", "WHERE", "HOW", "WHY", "WHEN"]);

export const CheckDefZ = z.looseObject({
  key: z.string(),
  label: z.string(),
  wTag: WTagZ,
  weight: z.union([z.literal(1), z.literal(3), z.literal(5)]),
  attributes: z.array(AttributeZ),
});

export const PackZ = z.looseObject({
  id: z.string(),
  name: z.string(),
  roles: z.array(z.looseObject({ key: RoleKeyZ, label: z.string() })).min(1),
  approverRole: RoleKeyZ,
  successorRole: RoleKeyZ,
  leaverRole: RoleKeyZ,
  contactsRoles: z.array(RoleKeyZ),
  entities: z.array(z.looseObject({
    key: z.string(),
    label: z.string(),
    aliases: z.array(z.string()).default([]),
  })),
  sourceAuthority: z.record(z.string(), z.record(z.string(), z.number())),
  checklists: z.record(z.string(), z.array(CheckDefZ)),
  roleTemplates: z.record(z.string(), z.array(z.looseObject({
    key: z.string(),
    title: z.string(),
    kind: ResponsibilityKindZ,
    entities: z.array(z.string()).default([]),
  }))),
  footprint: z.looseObject({
    repeatMin: z.number(),
    distinctWeeksMin: z.number(),
    ownershipShare: z.number(),
    windowMonths: z.number(),
  }),
  readback: z.array(z.looseObject({
    key: z.string(),
    label: z.string(),
    type: z.enum(["date", "text", "contact", "command"]),
    entity: z.string(),
    attribute: AttributeZ,
  })),
  uploadDefaults: z.looseObject({ roleSet: z.array(RoleKeyZ) }),
});

export type Pack = z.infer<typeof PackZ>;
export type PackCheck = z.infer<typeof CheckDefZ>;
