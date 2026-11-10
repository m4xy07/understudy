// Injected model call used by the stand-in successor. Lacuna core never imports the
// model client; the caller (src/lib/lacuna/index.ts) passes one in, or nothing.
import type { ZodType } from "zod";

export type ModelResult<T> =
  | { ok: true; data: T; cached: boolean }
  | { ok: false; error: string };

export type ModelCall = <T>(opts: {
  system: string;
  user: string;
  schema: ZodType<T>;
  jsonSchemaName: string;
}) => Promise<ModelResult<T>>;
