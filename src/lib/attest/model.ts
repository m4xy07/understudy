// The model call Attest injects into the pure core (extraction and support check).
// Goes through src/lib/model/client.ts (cache first). When the endpoint is down, the call runs
// cache-only so precomputed demo answers still replay and nothing waits on a timeout.
// A recorder lets scripts/precompute.ts export exactly the cache rows Attest used.
import { cacheKey, callJson, modelTag } from "@/lib/model/client";
import type { ModelCall } from "./core/schema";

const g = globalThis as unknown as { __attestKeys?: Set<string> | null };

/** Start recording the cache keys of every Attest model call (scripts only). */
export function startRecordingKeys(): Set<string> {
  g.__attestKeys = new Set();
  return g.__attestKeys;
}

export function stopRecordingKeys(): Set<string> {
  const keys = g.__attestKeys ?? new Set<string>();
  g.__attestKeys = null;
  return keys;
}

export interface CallStats {
  calls: number;
  cached: number;
  failed: number;
  errors: string[];
}

export function newStats(): CallStats {
  return { calls: 0, cached: 0, failed: 0, errors: [] };
}

/** A ModelCall over callJson. `cacheOnly` skips the network (model unavailable). */
export function attestModelCall(opts: { cacheOnly: boolean; stats?: CallStats }): ModelCall {
  return async (o) => {
    const user = o.user.trimEnd().endsWith("/no_think") ? o.user : `${o.user.trimEnd()}\n/no_think`;
    g.__attestKeys?.add(cacheKey(modelTag(), o.system, user, o.jsonSchemaName));
    const res = await callJson({
      system: o.system,
      user: o.user,
      schema: o.schema,
      jsonSchemaName: o.jsonSchemaName,
      jsonSchema: o.jsonSchema,
      cacheOnly: opts.cacheOnly,
    });
    if (opts.stats) {
      opts.stats.calls++;
      if (res.ok && res.cached) opts.stats.cached++;
      if (!res.ok) {
        opts.stats.failed++;
        if (opts.stats.errors.length < 5 && !opts.stats.errors.includes(res.error)) opts.stats.errors.push(res.error);
      }
    }
    return res;
  };
}
