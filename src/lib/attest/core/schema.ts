// Attest extraction schema: what the model must return, and the shapes the
// extractor hands to the verifier. Contract: docs/ARCHITECTURE.md section 4 "Claims (Attest)".
// Pure module: no database, no network.
import { z } from "zod";
import type { Attribute } from "@/lib/types";

/** The closed attribute list (ARCHITECTURE section 2), in contract order. */
export const ATTRIBUTES = [
  "owner", "status", "deadline", "location", "procedure", "access",
  "decision", "reason", "dependency", "contact", "risk",
] as const satisfies readonly Attribute[];

const ATTRIBUTE_SET: ReadonlySet<string> = new Set<string>(ATTRIBUTES);

export function isAttribute(x: unknown): x is Attribute {
  return typeof x === "string" && ATTRIBUTE_SET.has(x);
}

/** Entity key used when a fact is about nothing in the pack's entity list. */
export const OTHER_ENTITY = "other";

/** The part of the setting pack extraction needs. The full pack (src/lib/pack) satisfies it structurally. */
export interface PackEntity {
  key: string;
  label: string;
  aliases: string[];
}
export interface ExtractionPack {
  entities: PackEntity[];
}

/**
 * Injected model call (implemented by src/lib/model/client.ts). Parses the reply with `schema`,
 * retries once on invalid JSON, and never throws for model problems: it returns `ok: false`.
 * `jsonSchema` is the hand-written strict JSON Schema for `response_format`; when a client
 * ignores it, it may derive one from `schema` instead.
 */
export type ModelCall = <T>(opts: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  jsonSchemaName: string;
  jsonSchema?: Record<string, unknown>;
}) => Promise<{ ok: true; data: T; cached: boolean } | { ok: false; error: string }>;

// ---------------------------------------------------------------------------
// Contract shape of the model output (strict). Used by tests and by anyone who
// wants the canonical type; the extractor itself validates claim by claim.

export const citationSchema = z.object({
  segment_id: z.string().min(1),
  quote: z.string().nullable(),
});

export const extractedClaimSchema = z.object({
  entity: z.string().min(1),
  attribute: z.enum(ATTRIBUTES),
  value: z.string().min(1),
  statement: z.string().min(1),
  citations: z.array(citationSchema).min(1),
});

export const extractionOutputSchema = z.object({
  claims: z.array(extractedClaimSchema),
});

export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

// ---------------------------------------------------------------------------
// Transport schemas. The envelope only requires `{ claims: [...] }` so that one
// malformed claim does not throw away the whole batch; each element is then
// checked with `rawClaimSchema`. `attribute` and `entity` are plain strings here
// so off-list attributes can be counted for review instead of failing the parse.
// zod objects strip unknown keys, so model-supplied labels (trust, verified,
// accepted, role sets, states) never survive parsing.

export const modelResponseSchema = z.object({
  claims: z.array(z.unknown()),
});
export type ModelResponse = z.infer<typeof modelResponseSchema>;

const trimmed = z.string().transform((s) => s.trim());

export const rawClaimSchema = z.object({
  entity: trimmed.pipe(z.string().min(1)),
  attribute: z.string().transform((s) => s.trim().toLowerCase()).pipe(z.string().min(1)),
  value: trimmed.pipe(z.string().min(1)),
  statement: trimmed.pipe(z.string().min(1)),
  citations: z
    .array(
      z.object({
        segment_id: trimmed.pipe(z.string().min(1)),
        quote: z.string().nullable().optional(),
      }),
    )
    .min(1),
});
export type RawClaim = z.infer<typeof rawClaimSchema>;

export const EXTRACTION_JSON_SCHEMA_NAME = "attest_claims";

/**
 * Hand-written strict JSON Schema for `response_format: { type: "json_schema" }`.
 * Entity is constrained to the pack's keys plus "other"; attribute to the closed list.
 */
export function buildExtractionJsonSchema(entityKeys: readonly string[]): Record<string, unknown> {
  const entities = [...new Set([...entityKeys, OTHER_ENTITY])];
  return {
    type: "object",
    additionalProperties: false,
    required: ["claims"],
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["entity", "attribute", "value", "statement", "citations"],
          properties: {
            entity: { type: "string", enum: entities },
            attribute: { type: "string", enum: [...ATTRIBUTES] },
            value: { type: "string", minLength: 1 },
            statement: { type: "string", minLength: 1 },
            citations: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["segment_id", "quote"],
                properties: {
                  segment_id: { type: "string" },
                  quote: { type: ["string", "null"] },
                },
              },
            },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// What the extractor (model or structured) hands to the verifier.

export interface DraftCitation {
  segmentId: string;
  quote: string | null;        // as given; the verifier decides exactness
}

export interface DraftClaim {
  entity: string;              // a pack entity key or "other"
  entityRaw: string | null;    // what the source said when it did not resolve to a pack key
  attribute: Attribute;
  value: string;
  statement: string;
  citations: DraftCitation[];
  origin: "extracted" | "structured";
  batchId: string;
  batchSegmentIds: string[];   // every segment the model saw in this batch (citation check)
}

/** A claim the model returned with an attribute outside the closed list (kept for a review list). */
export interface OffListClaim {
  batchId: string;
  entity: string;
  attribute: string;
  value: string;
  statement: string;
  citations: DraftCitation[];
}
