import { describe, expect, it } from "vitest";
import { getPack } from "@/lib/pack";
import {
  leaverName, leaverPersonIds, markPartlyRestricted, mergeJudgements, toLacunaPack,
} from "@/lib/lacuna/adapt";
import { checksByResp } from "@/lib/lacuna/core/checks";
import { deterministicStandin, namesDate, type ClaimMeta, type VisibleClaim } from "@/lib/lacuna/core/standin";
import type { CheckResult, Person, Responsibility } from "@/lib/types";

const pack = getPack();
const lpack = toLacunaPack(pack);
const ALL = ["president", "tech_lead", "new_member", "treasurer", "leaver"] as const;

function resp(id: string, kind: Responsibility["kind"], entities: string[]): Responsibility {
  return { id, workspaceId: "ws", key: id, title: id, kind, entities, origin: "footprint", originDetail: "", dueDate: null, confirmed: false };
}
function claim(id: string, entity: string, attribute: VisibleClaim["attribute"], value: string, extra: Partial<VisibleClaim> = {}): VisibleClaim {
  return { id, entity, attribute, value, statement: value, trust: "from_record", state: "active", roleSet: [...ALL], ...extra };
}

describe("pack adaptation", () => {
  it("WHO checks are answered by a person, not a credential name", () => {
    const cred = lpack.checklists!.deploy_operate!.find((c) => c.key === "credential_owner")!;
    expect(cred.attributes).toEqual(["owner"]);
    const r = resp("r1", "deploy_operate", ["firmware-deploy"]);
    const res = deterministicStandin(r, checksByResp([r], lpack).r1, [claim("c1", "firmware-deploy", "access", "OTA_PASSWORD")], new Map(), "tech_lead");
    expect(res.find((x) => x.checkKey === "credential_owner")?.coverage).toBe("missing");
  });

  it("next-date checks need an upcoming date; a cadence or a past date does not count", () => {
    const next = lpack.checklists!.recurring_obligation!.find((c) => c.key === "next_due_date")!;
    expect(next.needsDate).toBe(true);
    expect(lpack.checklists!.recurring_obligation!.find((c) => c.key === "cadence")!.needsDate).toBeUndefined();
    expect(namesDate("2026-12-01")).toBe(true);
    expect(namesDate("by 5 Dec")).toBe(true);
    expect(namesDate("Once every term")).toBe(false);
    const r = resp("r1", "recurring_obligation", ["lab-booking"]);
    const checks = checksByResp([r], lpack).r1;
    const run = (claims: VisibleClaim[]) =>
      deterministicStandin(r, checks, claims, new Map(), "tech_lead", "2026-11-11").find((x) => x.checkKey === "next_due_date")!.coverage;
    expect(run([claim("c1", "lab-booking", "deadline", "Once every term")])).toBe("missing");
    expect(run([claim("c1", "lab-booking", "deadline", "2026-11-01")])).toBe("missing");
    expect(run([claim("c1", "lab-booking", "deadline", "2026-12-01")])).toBe("covered");
    // the cadence check still takes the cadence claim
    expect(deterministicStandin(r, checks, [claim("c1", "lab-booking", "deadline", "Once every term")], new Map(), "tech_lead", "2026-11-11")
      .find((x) => x.checkKey === "cadence")!.coverage).toBe("covered");
  });

  it("finds every person record of the leaver by name", () => {
    expect(leaverName(pack)).toBe("Priya");
    const people: Person[] = [
      { id: "p-1", displayName: "Priya Nair", emailHmac: "h", aliases: [] },
      { id: "p-2", displayName: "Kabir", emailHmac: null, aliases: [] },
      { id: "p-9", displayName: "priya", emailHmac: null, aliases: [] },
      { id: "p-10", displayName: "P. Nair", emailHmac: null, aliases: ["Priya N"] },
      { id: "p-11", displayName: "Priyanka", emailHmac: null, aliases: [] },
    ];
    expect(leaverPersonIds(people, "Priya")).toEqual(["p-1", "p-9", "p-10"]);
  });
});

describe("merging the stand-in with the record", () => {
  const base = (coverage: CheckResult["coverage"], ids: string[] = ["c1"]): CheckResult => ({
    responsibilityId: "r1", checkKey: "steps", coverage, claimIds: ids, bestTrust: coverage === "missing" ? null : "from_record", note: "",
  });
  it("the model can lower coverage but never raise it; conflicting and restricted are facts", () => {
    expect(mergeJudgements([base("covered")], [base("missing", [])])[0].coverage).toBe("missing");
    expect(mergeJudgements([base("covered")], [base("partial")])[0].coverage).toBe("partial");
    expect(mergeJudgements([{ ...base("missing", []), note: "no steps written" }], [base("covered")])[0]).toMatchObject({ coverage: "missing", note: "no steps written", claimIds: [] });
    expect(mergeJudgements([base("partial")], [base("covered")])[0].coverage).toBe("partial");
    expect(mergeJudgements([base("covered")], [base("conflicting")])[0].coverage).toBe("conflicting");
    expect(mergeJudgements([base("covered")], [base("restricted", [])])[0].coverage).toBe("restricted");
  });

  it("a covered multi-valued check is partial when more values exist for other roles", () => {
    const r = resp("r1", "external_relationship", ["title-sponsor"]);
    const checks = checksByResp([r], lpack);
    const covered: CheckResult = { responsibilityId: "r1", checkKey: "open_commitments", coverage: "covered", claimIds: ["c1"], bestTrust: "from_record", note: "" };
    const hidden = new Map<string, ClaimMeta>([["c2", { entity: "title-sponsor", attribute: "dependency", state: "active", trust: "from_record", roleSet: ["president", "treasurer", "leaver"] }]]);
    expect(markPartlyRestricted([covered], [r], checks, hidden, "tech_lead")[0].coverage).toBe("partial");
    expect(markPartlyRestricted([covered], [r], checks, hidden, "treasurer")[0].coverage).toBe("covered");
  });
});
