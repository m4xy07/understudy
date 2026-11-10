import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { supportCheck, type ModelCall } from "@/lib/attest/core/support";
import type { Claim } from "@/lib/types";
import { claim, seg, segMap } from "./fixtures-verify/build";

type Verdict = "yes" | "partly" | "no";

/** A fake model: answers by claim statement, records every prompt it saw. */
function fakeModel(verdictFor: (statement: string) => Verdict | undefined, fail = false) {
  const prompts: string[] = [];
  const call: ModelCall = async <T,>(opts: { system: string; user: string; schema: ZodType<T>; jsonSchemaName: string }) => {
    prompts.push(opts.user);
    if (fail) return { ok: false as const, error: "model unavailable" };
    const results: { id: string; verdict: Verdict }[] = [];
    for (const m of opts.user.matchAll(/### (c\d+)\nStatement: (.*)/g)) {
      const v = verdictFor(m[2]);
      if (v) results.push({ id: m[1], verdict: v });
    }
    return { ok: true as const, data: opts.schema.parse({ results }), cached: false };
  };
  return { call, prompts };
}

function setup() {
  const s = seg({ text: "Rollback: flash the previous release tag with make flash TAG=v1.3" });
  const mk = (id: string, statement: string, trust: Claim["trust"]) =>
    claim({ id, statement, value: id, trust, entity: "firmware-deploy", attribute: "procedure",
      citations: [{ segmentId: s.id, quote: "flash the previous release tag", accepted: true, exact: trust === "from_record" }] });
  return { s, mk };
}

describe("support check", () => {
  it("only lowers trust: no -> inferred; partly keeps from_record; yes never raises inferred", async () => {
    const { s, mk } = setup();
    const claims = [
      mk("c-no", "STATEMENT-NO", "from_record"),
      mk("c-partly", "STATEMENT-PARTLY", "from_record"),
      mk("c-yes-inferred", "STATEMENT-YES", "inferred"),
      mk("c-no-corr", "STATEMENT-NO-2", "corroborated"),
    ];
    const { call } = fakeModel((st) => (st.startsWith("STATEMENT-NO") ? "no" : st === "STATEMENT-PARTLY" ? "partly" : "yes"));
    const res = await supportCheck(claims, segMap(s), call);
    const get = (id: string) => res.claims.find((c) => c.id === id)!;
    expect(get("c-no")).toMatchObject({ trust: "inferred", supportCheck: "no" });
    expect(get("c-partly")).toMatchObject({ trust: "from_record", supportCheck: "partly" });
    expect(get("c-yes-inferred")).toMatchObject({ trust: "inferred", supportCheck: "yes" });
    expect(get("c-no-corr")).toMatchObject({ trust: "inferred", supportCheck: "no" });
    expect(res.downgraded.sort()).toEqual(["c-no", "c-no-corr"]);
    expect(res.failures).toEqual([]);
    expect(claims[0].trust).toBe("from_record"); // input not mutated
  });

  it("model failures leave claims unchanged and are reported", async () => {
    const { s, mk } = setup();
    const claims = [mk("a", "A", "from_record"), mk("b", "B", "from_record")];
    const res = await supportCheck(claims, segMap(s), fakeModel(() => "no", true).call);
    expect(res.claims.map((c) => [c.trust, c.supportCheck])).toEqual([["from_record", null], ["from_record", null]]);
    expect(res.failures).toEqual([{ claimIds: ["a", "b"], error: "model unavailable" }]);
  });

  it("missing verdicts are reported and leave those claims unchanged", async () => {
    const { s, mk } = setup();
    const claims = [mk("a", "KEEP", "from_record"), mk("b", "SKIPME", "from_record")];
    const res = await supportCheck(claims, segMap(s), fakeModel((st) => (st === "KEEP" ? "yes" : undefined)).call);
    expect(res.checked).toEqual(["a"]);
    expect(res.failures).toEqual([{ claimIds: ["b"], error: "no verdict returned" }]);
    expect(res.claims[1].supportCheck).toBeNull();
  });

  it("batches at most 20 claims per call and never mixes role sets in one call", async () => {
    const open = seg({ text: "Open text about the lab", thread: "#lab" });
    const secret = seg({ text: "CANARY-AAAA treasurer only budget line", thread: "#finance", roleSet: ["president", "treasurer"] });
    const claims: Claim[] = [];
    for (let i = 0; i < 45; i++) {
      claims.push(claim({ id: `o${i}`, statement: `open ${i}`, value: `o${i}`, entity: "lab-booking", attribute: "status",
        citations: [{ segmentId: open.id, quote: "lab", accepted: true, exact: true }] }));
    }
    claims.push(claim({ id: "s1", statement: "secret 1", value: "s1", roleSet: ["president", "treasurer"],
      citations: [{ segmentId: secret.id, quote: "budget line", accepted: true, exact: true }] }));
    claims.push(claim({ id: "struct", statement: "structured", value: "x", origin: "structured" }));

    const { call, prompts } = fakeModel(() => "yes");
    const res = await supportCheck(claims, segMap(open, secret), call);
    expect(res.calls).toBe(4); // 20 + 20 + 5 open, 1 restricted
    for (const p of prompts) {
      const n = [...p.matchAll(/### c\d+/g)].length;
      expect(n).toBeLessThanOrEqual(20);
      // A prompt with the restricted segment contains nothing from the open thread, and vice versa.
      expect(p.includes("CANARY-AAAA") && p.includes("Open text about the lab")).toBe(false);
    }
    expect(res.skipped).toEqual([{ claimId: "struct", reason: "origin structured" }]);
    expect(res.checked).toHaveLength(46);
  });
});
