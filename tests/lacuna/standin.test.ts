import { describe, expect, it } from "vitest";
import type { CheckResult } from "@/lib/types";
import {
  buildStandinPrompt, deterministicStandin, evaluateStandin, runStandin, RESTRICTED_NOTE,
  STANDIN_JSON_SCHEMA, StandinOutputSchema, type StandinOutput,
} from "@/lib/lacuna/core/standin";
import { checksFor } from "@/lib/lacuna/core/checks";
import type { ModelCall } from "@/lib/lacuna/core/model";
import { claim, metaIndex, pack, resp } from "./fixtures";

const R = resp({ id: "r1", kind: "deploy_operate", entities: ["firmware-deploy"] });
const CHECKS = checksFor(R, pack);
const role = "tech_lead" as const;

function ctx(visible: ReturnType<typeof claim>[], all = visible) {
  return {
    resp: R, checks: CHECKS, role,
    visibleClaimsById: new Map(visible.map((c) => [c.id, c])),
    allClaimsMeta: metaIndex(all),
  };
}

function out(entries: Partial<StandinOutput["checks"][number]>[]): StandinOutput {
  return {
    checks: entries.map((e) => ({ check_key: "rollback", status: "can_do", claim_ids: [], blocker: "", ...e })),
  };
}

const byKey = (rs: CheckResult[], key: string): CheckResult => rs.find((r) => r.checkKey === key)!;

describe("prompt", () => {
  it("lists claims as [id] (attribute, trust) statement and asks the tomorrow question", () => {
    const c = claim({ id: "c-roll", entity: "firmware-deploy", attribute: "procedure", statement: "Rollback: reflash v1.2 with make flash-prev" });
    const { system, user } = buildStandinPrompt(R, CHECKS, [c]);
    expect(user).toContain("[c-roll] (procedure, from_record) Rollback: reflash v1.2 with make flash-prev");
    expect(user).toContain("You must do this tomorrow. For each check, cite claim IDs that let you do it, or say what stops you.");
    expect(user).toContain("- rollback: Rollback");
    expect(system.length).toBeGreaterThan(0);
    expect(STANDIN_JSON_SCHEMA).toMatchObject({ type: "object" });
    expect(StandinOutputSchema.safeParse({ checks: [{ check_key: "x", status: "maybe", claim_ids: [], blocker: "" }] }).success).toBe(false);
  });
});

describe("evaluateStandin (code decides coverage)", () => {
  it("drops citations to claims that do not exist, are invisible, superseded or dropped", () => {
    const good = claim({ id: "ok", entity: "firmware-deploy", attribute: "procedure" });
    const hidden = claim({ id: "hid", entity: "firmware-deploy", attribute: "procedure", roleSet: ["president"] });
    const sup = claim({ id: "sup", entity: "firmware-deploy", attribute: "procedure", state: "superseded" });
    const drop = claim({ id: "drop", entity: "firmware-deploy", attribute: "procedure", state: "dropped" });
    // "hid" sneaks into the visible map (defensive: the role set still rules it out).
    const res = evaluateStandin(
      out([{ check_key: "rollback", claim_ids: ["ghost", "hid", "sup", "drop", "ok"] }]),
      ctx([good, hidden, sup, drop]),
    );
    const r = byKey(res, "rollback");
    expect(r.coverage).toBe("covered");
    expect(r.claimIds).toEqual(["ok"]);
  });

  it("drops a citation whose metadata says superseded even if the visible copy is stale", () => {
    const stale = claim({ id: "s1", entity: "firmware-deploy", attribute: "procedure" });
    const all = [{ ...stale, state: "superseded" as const }];
    const r = byKey(evaluateStandin(out([{ claim_ids: ["s1"] }]), ctx([stale], all)), "rollback");
    expect(r.coverage).toBe("missing");
  });

  it("turns can_do without a valid citation into missing", () => {
    const r = byKey(evaluateStandin(out([{ claim_ids: ["nope"] }]), ctx([])), "rollback");
    expect(r.coverage).toBe("missing");
    expect(r.claimIds).toEqual([]);
  });

  it("marks a check conflicting when its only valid citations are conflicting", () => {
    const a = claim({ id: "a", entity: "firmware-deploy", attribute: "procedure", state: "conflicting" });
    const b = claim({ id: "b", entity: "firmware-deploy", attribute: "procedure", state: "conflicting", trust: "leaver_said" });
    const r = byKey(evaluateStandin(out([{ claim_ids: ["a", "b"] }]), ctx([a, b])), "rollback");
    expect(r.coverage).toBe("conflicting");
    expect(r.bestTrust).toBe("from_record");
  });

  it("keeps partial as partial and cannot as missing with the blocker", () => {
    const a = claim({ id: "a", entity: "firmware-deploy", attribute: "procedure" });
    const res = evaluateStandin(out([
      { check_key: "steps", status: "partial", claim_ids: ["a"], blocker: "No board version" },
      { check_key: "verify", status: "cannot", claim_ids: [], blocker: "No test procedure" },
    ]), ctx([a]));
    expect(byKey(res, "steps")).toMatchObject({ coverage: "partial", note: "No board version" });
    expect(byKey(res, "verify")).toMatchObject({ coverage: "missing", note: "No test procedure" });
  });

  it("caps can_do backed only by inferred evidence at partial", () => {
    const a = claim({ id: "a", entity: "firmware-deploy", attribute: "procedure", trust: "inferred" });
    expect(byKey(evaluateStandin(out([{ claim_ids: ["a"] }]), ctx([a])), "rollback").coverage).toBe("partial");
  });

  it("reports restricted when no visible evidence but another role's active claim satisfies the check", () => {
    const secret = claim({ id: "sec", entity: "firmware-deploy", attribute: "access", roleSet: ["president"] });
    const res = evaluateStandin(out([{ check_key: "credential_owner", status: "cannot", blocker: "Unknown" }]), ctx([], [secret]));
    const r = byKey(res, "credential_owner");
    expect(r.coverage).toBe("restricted");
    expect(r.note).toBe(RESTRICTED_NOTE);
    expect(r.claimIds).toEqual([]);
    // the model even citing the hidden id does not leak it
    const r2 = byKey(evaluateStandin(out([{ check_key: "credential_owner", claim_ids: ["sec"] }]), ctx([], [secret])), "credential_owner");
    expect(r2).toMatchObject({ coverage: "restricted", claimIds: [] });
  });

  it("sets bestTrust to the strongest valid citation", () => {
    const a = claim({ id: "a", entity: "firmware-deploy", attribute: "procedure", trust: "leaver_said" });
    const b = claim({ id: "b", entity: "firmware-deploy", attribute: "procedure", trust: "corroborated" });
    const r = byKey(evaluateStandin(out([{ claim_ids: ["a", "b"] }]), ctx([a, b])), "rollback");
    expect(r.bestTrust).toBe("corroborated");
  });
});

describe("deterministicStandin", () => {
  it("follows the section 4 fallback", () => {
    const visible = [
      claim({ id: "p1", entity: "firmware-deploy", attribute: "procedure", trust: "leaver_said" }),
      claim({ id: "l1", entity: "firmware-deploy", attribute: "location", trust: "inferred" }),
      claim({ id: "o1", entity: "other-entity", attribute: "owner" }),
    ];
    const hidden = claim({ id: "h1", entity: "firmware-deploy", attribute: "access", roleSet: ["president", "treasurer"] });
    const res = deterministicStandin(R, CHECKS, visible, metaIndex([...visible, hidden]), role);
    expect(byKey(res, "steps")).toMatchObject({ coverage: "covered", bestTrust: "leaver_said", claimIds: ["p1"] });
    expect(byKey(res, "rollback").coverage).toBe("covered");
    expect(byKey(res, "access_path")).toMatchObject({ coverage: "partial", bestTrust: "inferred" });
    expect(byKey(res, "credential_owner")).toMatchObject({ coverage: "restricted", note: RESTRICTED_NOTE });
  });

  it("returns conflicting when only conflicting claims exist and missing when nothing does", () => {
    const visible = [claim({ id: "x", entity: "firmware-deploy", attribute: "procedure", state: "conflicting" })];
    const res = deterministicStandin(R, CHECKS, visible, metaIndex(visible), role);
    expect(byKey(res, "rollback").coverage).toBe("conflicting");
    expect(byKey(res, "credential_owner").coverage).toBe("missing");
  });

  it("ignores superseded, dropped and invisible claims", () => {
    const visible = [
      claim({ id: "s", entity: "firmware-deploy", attribute: "procedure", state: "superseded" }),
      claim({ id: "d", entity: "firmware-deploy", attribute: "procedure", state: "dropped" }),
      claim({ id: "i", entity: "firmware-deploy", attribute: "procedure", roleSet: ["president"] }),
    ];
    const res = deterministicStandin(R, CHECKS, visible, metaIndex(visible), role);
    // "i" is active and hidden from tech_lead: restricted, not covered
    expect(byKey(res, "rollback").coverage).toBe("restricted");
  });

  it("honours optional pack keywords for checks sharing an attribute", () => {
    const checks = CHECKS.map((c) => (c.key === "rollback" ? { ...c, keywords: ["rollback", "revert"] } : c));
    const visible = [claim({ id: "p", entity: "firmware-deploy", attribute: "procedure", value: "run make flash" })];
    const res = deterministicStandin(R, checks, visible, metaIndex(visible), role);
    expect(byKey(res, "steps").coverage).toBe("covered");
    expect(byKey(res, "rollback").coverage).toBe("missing");
  });
});

describe("runStandin", () => {
  const visible = [
    claim({ id: "p1", entity: "firmware-deploy", attribute: "procedure" }),
    claim({ id: "old", entity: "firmware-deploy", attribute: "procedure", state: "superseded", statement: "OLD-STATEMENT" }),
  ];

  it("uses the model when it answers, and only shows live visible claims on the entity", async () => {
    let seen = "";
    const call: ModelCall = async (opts) => {
      seen = opts.user;
      expect(opts.jsonSchemaName).toBe("standin_successor");
      const data = { checks: [{ check_key: "steps", status: "can_do", claim_ids: ["p1"], blocker: "" }] };
      return { ok: true, data: opts.schema.parse(data), cached: false };
    };
    const run = await runStandin({ resps: [R], role, visibleClaims: visible, allClaimsMeta: metaIndex(visible), pack, call });
    expect(run.modelUsed).toBe(true);
    expect(seen).toContain("[p1]");
    expect(seen).not.toContain("OLD-STATEMENT");
    expect(byKey(run.results, "steps").coverage).toBe("covered");
    expect(byKey(run.results, "rollback").coverage).toBe("missing"); // model did not answer it
    expect(run.results).toHaveLength(CHECKS.length);
  });

  it("falls back to the deterministic path when the model is unavailable or throws", async () => {
    const down: ModelCall = async () => ({ ok: false, error: "model unavailable" });
    const run = await runStandin({ resps: [R], role, visibleClaims: visible, allClaimsMeta: metaIndex(visible), pack, call: down });
    expect(run.modelUsed).toBe(false);
    expect(run.errors).toEqual([{ responsibilityKey: "R01", error: "model unavailable" }]);
    expect(byKey(run.results, "rollback").coverage).toBe("covered");

    const boom: ModelCall = async () => { throw new Error("socket hang up"); };
    const run2 = await runStandin({ resps: [R], role, visibleClaims: visible, allClaimsMeta: metaIndex(visible), pack, call: boom });
    expect(run2.modelUsed).toBe(false);
    expect(run2.errors[0].error).toBe("socket hang up");

    const none = await runStandin({ resps: [R], role, visibleClaims: visible, allClaimsMeta: metaIndex(visible), pack });
    expect(none).toMatchObject({ modelUsed: false, errors: [] });
  });
});
