// Tests never call the live model: vitest.config.mts sets MODEL_DISABLED=1 for every run.
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { callJson, modelAvailable, modelDisabled } from "@/lib/model/client";

afterAll(async () => {
  vi.unstubAllGlobals();
  await db().end();
});

describe("model client in tests", () => {
  it("is disabled: no probe, no network, a fast typed failure on a cache miss", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(process.env.MODEL_DISABLED).toBe("1");
    expect(modelDisabled()).toBe(true);
    expect(await modelAvailable()).toBe(false);
    const res = await callJson({
      system: "test system",
      user: `a prompt no cache holds ${Date.now()} ${Math.random()}`,
      schema: z.object({ ok: z.boolean() }),
      jsonSchemaName: "model_disabled_probe",
    });
    expect(res).toEqual({ ok: false, error: "model disabled in tests" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
