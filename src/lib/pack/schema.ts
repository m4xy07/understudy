// zod schema for the setting pack (docs/ARCHITECTURE.md section 1a), version 2.
// Objects are "loose": extra keys a module adds later are kept, never rejected.
// A role key is defined by the pack: core never lists role keys, it reads the role flags.
import { z } from "zod";

/** Format of a role key. Which keys exist is decided by each pack (see resolvePack in ./index). */
export const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
export const PACK_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const RoleKeyZ = z.string().regex(ROLE_KEY_RE, "role key must match ^[a-z][a-z0-9_]{1,31}$");
export const SourceKindZ = z.enum(["whatsapp", "slack", "github", "tasks_csv", "markdown", "ics", "interview", "finding"]);
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

/**
 * One role of the setting. The flags give a role its job in core:
 *   approver            the only role that reviews and approves (exactly one)
 *   successor           the role the stand-in successor is tested as (exactly one)
 *   leaver              the leaving person: answers questions, can never approve (exactly one)
 *   restrictedAudience  "sees least": a claim hidden from such a role is sensitive (at least one)
 */
export const PackRoleZ = z.looseObject({
  key: RoleKeyZ,
  label: z.string().min(1),
  /** How copy refers to the role inside a sentence. Default: the label. */
  short: z.string().min(1).optional(),
  approver: z.boolean().optional(),
  successor: z.boolean().optional(),
  leaver: z.boolean().optional(),
  restrictedAudience: z.boolean().optional(),
});

export const PackZ = z.looseObject({
  id: z.string().regex(PACK_ID_RE, "pack id must match ^[a-z][a-z0-9_-]{0,31}$"),
  name: z.string().min(1),
  roles: z.array(PackRoleZ).min(3),
  // Legacy keys from pack version 1. Optional; when present they must agree with the role flags.
  approverRole: RoleKeyZ.optional(),
  successorRole: RoleKeyZ.optional(),
  leaverRole: RoleKeyZ.optional(),
  /** The leaving person, as their name appears in the sources (used to find their person records). */
  leaverPerson: z.looseObject({ name: z.string().min(1), aliases: z.array(z.string()).optional() }),
  /** Who holds which role, by full name as the sources show it. A role nobody holds is left out. */
  roleHolders: z.record(z.string(), z.array(z.string().min(1))).optional(),
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
  /** Display names for the five responsibility kinds in this setting. */
  kindLabels: z.record(z.string(), z.string()).optional(),
  /**
   * Setting-specific text for the extraction prompt. Every string here is part of the model cache
   * key: changing one changes every extraction key of this pack.
   */
  extraction: z.looseObject({
    examples: z.record(z.string(), z.string()).optional(),   // keyed by attribute
    entityHint: z.string().optional(),
    contactExample: z.string().optional(),
  }).optional(),
  /** The synthetic demo of this setting. A pack without it is valid for empty workspaces only. */
  demo: z.looseObject({
    dataDir: z.string().min(1),          // relative to the project root; holds sources.json
    today: z.string().min(1),            // the fixed "now" of the demo story, ISO 8601
    button: z.string().min(1),           // label of the landing button
    pendingText: z.string().optional(),
    title: z.string().min(1),
    blurb: z.string().min(1),
    /** A sample leaver answer to the top gap question, used by scripts/precompute.ts. */
    sampleAnswer: z.string().optional(),
  }).optional(),
  /** Sensitivity classes and the roles that may see each (owned by the confidentiality work). */
  sensitivity: z.record(z.string(), z.array(RoleKeyZ)).optional(),
  /** Proper nouns of this setting that scripts/check-literals.ts must never find in core code. */
  forbiddenInCore: z.array(z.string().min(1)).optional(),
});

export type Pack = z.infer<typeof PackZ>;
export type PackRole = z.infer<typeof PackRoleZ>;
export type PackCheck = z.infer<typeof CheckDefZ>;
