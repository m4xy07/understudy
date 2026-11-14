// Setting pack version 2: the loader's rules (each with a failing fixture), the role facts derived
// from the flags, and the pure core functions that now take those facts as arguments.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalRoles, defaultPackId, getPack, isRoleOf, listDemoPacks, listPacks, resolvePack, roleLabel, roleShort,
} from "@/lib/pack";
import { isSensitive, tierOf } from "@/lib/attest/core/rules";
import { canonicalRoleSet } from "@/lib/attest/core/extract";
import { intersectRoleSets } from "@/lib/attest/core/verify";
import { leaverName } from "@/lib/lacuna/adapt";
import { stubText } from "@/lib/relay/core/compile";
import { checkApprover, type ApprovalRoles } from "@/lib/relay/core/labels";
import { assignTier } from "@/lib/relay/core/review";
import { matchRoleHolders } from "@/lib/roles";
import { roleFromCookie } from "@/lib/session";
import { RECORD_TRUST, STRONG_TRUST, TRUST_LABEL, TRUST_ORDER, strongestTrust, weakestTrust } from "@/lib/trust";
import type { Person } from "@/lib/types";
import { makeClaim } from "../relay/fixtures";

const raw = () => JSON.parse(fs.readFileSync(path.join(process.cwd(), "packs", "club.json"), "utf8"));
type Raw = ReturnType<typeof raw>;
const broken = (edit: (p: Raw) => void) => {
  const p = raw();
  edit(p);
  return () => resolvePack(p);
};

/** A second, made-up setting: proves the rules follow the flags, not the club's keys. */
const garden = () => {
  const p = raw();
  p.id = "garden";
  p.name = "Community garden";
  p.roles = [
    { key: "chair", label: "Committee chair", approver: true },
    { key: "new_keeper", label: "Incoming plot keeper", short: "the incoming plot keeper", successor: true, restrictedAudience: true },
    { key: "volunteer", label: "Volunteer", restrictedAudience: true },
    { key: "old_keeper", label: "Outgoing plot keeper", leaver: true },
  ];
  delete p.approverRole;
  delete p.successorRole;
  delete p.leaverRole;
  p.leaverPerson = { name: "Asha", aliases: ["A. Rao"] };
  p.roleHolders = { chair: ["Meena Pillai"], new_keeper: ["Dev Anand"] };
  p.contactsRoles = ["chair", "new_keeper"];
  p.roleTemplates = { new_keeper: [] };
  p.uploadDefaults = { roleSet: ["chair", "new_keeper", "volunteer", "old_keeper"] };
  delete p.demo;
  delete p.extraction;
  return resolvePack(p);
};

describe("pack loader", () => {
  it("derives the club's role facts from the flags: the same roles the old constants named", () => {
    const club = getPack("club");
    expect(club.approverRole).toBe("president");
    expect(club.successorRole).toBe("tech_lead");
    expect(club.leaverRole).toBe("leaver");
    expect(club.restrictedAudienceRoles).toEqual(["new_member"]);
    expect(club.testRoles).toEqual(["tech_lead", "new_member"]);
    expect(club.roleOrder).toEqual(["president", "tech_lead", "new_member", "treasurer", "leaver"]);
    expect(leaverName(club)).toBe("Priya");
    expect(roleLabel(club.approverRole, club)).toBe("Club President");
    expect(roleShort(club.successorRole, club)).toBe("the incoming tech lead");
    expect(roleShort(club.leaverRole, club)).toBe("Priya");
    expect(approvalRoles(club)).toEqual({ approver: "president", leaver: "leaver", approverLabel: "Club President" });
  });

  it("the club names who holds each role; nobody holds the new-member role", () => {
    const club = getPack("club");
    expect(club.roleHolders).toEqual({
      president: ["Rohan Mehta"], tech_lead: ["Arjun Rao"], treasurer: ["Ananya Iyer"], leaver: ["Priya Nair"],
    });
    expect(club.roleHolders.new_member).toBeUndefined();
  });

  it("a pack with two restricted audience roles tests both, without repeating the successor", () => {
    const g = garden();
    expect(g.approverRole).toBe("chair");
    expect(g.leaverRole).toBe("old_keeper");
    expect(g.restrictedAudienceRoles).toEqual(["new_keeper", "volunteer"]);
    expect(g.testRoles).toEqual(["new_keeper", "volunteer"]);
    expect(g.roleHolders).toEqual({ chair: ["Meena Pillai"], new_keeper: ["Dev Anand"] });
    expect(roleShort("volunteer", g)).toBe("Volunteer"); // no short form: the label
  });

  it("packs/index.json names the default pack and the demos; core holds no pack id", () => {
    expect(defaultPackId()).toBe("club");
    expect(listPacks().map((p) => p.id)).toContain("club");
    const demo = listDemoPacks().find((p) => p.id === "club")!;
    expect(demo.demo.button).toBe("Open the robotics-club demo");
    expect(demo.demo.dataDir).toBe("data/demo");
    expect(demo.demo.today).toBe("2026-11-11T12:00:00+05:30");
  });

  it("a missing pack and a bad id fail with a readable message", () => {
    expect(() => getPack("nope")).toThrow(/Setting pack not found: packs\/nope\.json/);
    expect(() => getPack("../club")).toThrow(/Setting pack not found/);
  });

  it.each([
    ["duplicate role key", (p: Raw) => { p.roles[3].key = "tech_lead"; }, /roles: duplicate key "tech_lead"/],
    ["two approvers", (p: Raw) => { p.roles[3].approver = true; }, /need exactly one approver, one successor and one leaver/],
    ["no successor", (p: Raw) => { delete p.roles[1].successor; }, /need exactly one approver, one successor and one leaver/],
    ["approver is also the leaver", (p: Raw) => { delete p.roles[4].leaver; p.roles[0].leaver = true; }, /need exactly one approver, one successor and one leaver/],
    ["no restricted audience", (p: Raw) => { delete p.roles[2].restrictedAudience; }, /flag at least one restrictedAudience role/],
    ["restricted audience is the approver", (p: Raw) => { p.roles[0].restrictedAudience = true; }, /flag at least one restrictedAudience role/],
    ["unknown role in contactsRoles", (p: Raw) => { p.contactsRoles.push("janitor"); }, /contactsRoles: unknown role "janitor"/],
    ["unknown role in uploadDefaults", (p: Raw) => { p.uploadDefaults.roleSet.push("janitor"); }, /uploadDefaults\.roleSet: unknown role "janitor"/],
    ["unknown role in roleTemplates", (p: Raw) => { p.roleTemplates.janitor = []; }, /roleTemplates: unknown role "janitor"/],
    ["unknown role in roleHolders", (p: Raw) => { p.roleHolders.janitor = ["X Y"]; }, /roleHolders: unknown role "janitor"/],
    ["unknown role in sensitivity", (p: Raw) => { p.sensitivity = { finance: ["janitor"] }; }, /sensitivity\.finance: unknown role "janitor"/],
    ["upload default without the approver", (p: Raw) => { p.uploadDefaults.roleSet = ["tech_lead"]; }, /uploadDefaults\.roleSet must include the approver/],
    ["legacy approverRole disagrees", (p: Raw) => { p.approverRole = "treasurer"; }, /approverRole disagrees with the role flagged approver/],
    ["legacy leaverRole disagrees", (p: Raw) => { p.leaverRole = "treasurer"; }, /leaverRole disagrees with the role flagged leaver/],
    ["read-back names an unknown entity", (p: Raw) => { p.readback[0].entity = "nothing"; }, /readback: unknown entity "nothing"/],
    ["role template names an unknown entity", (p: Raw) => { p.roleTemplates.tech_lead[0].entities = ["nothing"]; }, /roleTemplates\.tech_lead: unknown entity "nothing"/],
    ["example for an unknown attribute", (p: Raw) => { p.extraction.examples.colour = "x"; }, /extraction\.examples: unknown attribute "colour"/],
    ["demo folder missing", (p: Raw) => { p.demo.dataDir = "data/does-not-exist"; }, /demo\.dataDir not found/],
    ["bad role key format", (p: Raw) => { p.roles[3].key = "Treasurer!"; }, /role key must match/],
    ["no leaverPerson", (p: Raw) => { delete p.leaverPerson; }, /leaverPerson/],
  ])("rejects a pack with %s", (_name, edit, message) => {
    expect(broken(edit)).toThrow(message);
  });

  it("a pack without extraction examples or a demo is valid (empty workspaces only)", () => {
    const g = garden();
    expect(g.demo).toBeUndefined();
    expect(g.extraction).toBeUndefined();
  });
});

describe("role facts are arguments, not constants", () => {
  const club = getPack("club");
  const clubRoles = approvalRoles(club);
  const gardenRoles: ApprovalRoles = approvalRoles(garden());

  it("checkApprover: the leaver never, the approver always, anyone else refused, for two settings", () => {
    expect(checkApprover("president", clubRoles)).toBeNull();
    expect(checkApprover("leaver", clubRoles)?.code).toBe("leaver_cannot_approve");
    expect(checkApprover("treasurer", clubRoles)?.code).toBe("not_approver");
    expect(checkApprover("chair", gardenRoles)).toBeNull();
    expect(checkApprover("old_keeper", gardenRoles)?.code).toBe("leaver_cannot_approve");
    expect(checkApprover("volunteer", gardenRoles)?.code).toBe("not_approver");
    // The club's approver key means nothing in another setting.
    expect(checkApprover("president", gardenRoles)?.code).toBe("not_approver");
    expect(checkApprover("volunteer", gardenRoles)?.message).toContain("Committee chair");
  });

  it("sensitivity follows the restrictedAudience flag: a claim hidden from such a role is tier C", () => {
    const visibleToAll = makeClaim({ id: "a", trust: "corroborated", roleSet: ["chair", "new_keeper", "volunteer", "old_keeper"] });
    const hiddenFromVolunteer = makeClaim({ id: "b", trust: "corroborated", roleSet: ["chair", "new_keeper", "old_keeper"] });
    const g = garden().restrictedAudienceRoles;
    expect(assignTier(visibleToAll, g)).toBe("A");
    expect(assignTier(hiddenFromVolunteer, g)).toBe("C");
    expect(tierOf(visibleToAll, g)).toBe("A");
    expect(tierOf(hiddenFromVolunteer, g)).toBe("C");
    expect(isSensitive(["chair", "volunteer"], g)).toBe(true);   // hidden from the other restricted role
    expect(isSensitive(["new_keeper", "volunteer"], g)).toBe(false);
    // The club key is not special any more.
    expect(isSensitive(["chair", "new_keeper", "volunteer"], ["volunteer"])).toBe(false);
  });

  it("stub text carries the pack's approver label", () => {
    expect(stubText(3, "Principal investigator")).toBe("3 restricted items. Ask the approver (Principal investigator).");
    expect(stubText(1, "Principal investigator")).toBe("1 restricted item. Ask the approver (Principal investigator).");
    expect(stubText(3, roleLabel(club.approverRole, club))).toBe("3 restricted items. Ask the approver (Club President).");
    expect(stubText(0, "Anyone")).toBeNull();
  });

  it("role sets are ordered by the pack's role order", () => {
    expect(canonicalRoleSet(["leaver", "president", "leaver", "tech_lead"], club.roleOrder)).toEqual(["president", "tech_lead", "leaver"]);
    expect(canonicalRoleSet(["volunteer", "chair"], ["chair", "new_keeper", "volunteer"])).toEqual(["chair", "volunteer"]);
    expect(intersectRoleSets([["leaver", "president", "treasurer"], ["treasurer", "president"]], club.roleOrder)).toEqual(["president", "treasurer"]);
    expect(intersectRoleSets([], club.roleOrder)).toEqual([]);
  });

  it("a role cookie from another pack counts as no cookie: the approver of this pack", () => {
    const g = garden();
    expect(roleFromCookie("volunteer", g)).toBe("volunteer");
    expect(roleFromCookie("tech_lead", g)).toBe("chair");
    expect(roleFromCookie(undefined, g)).toBe("chair");
    expect(roleFromCookie("tech_lead", club)).toBe("tech_lead");
    expect(roleFromCookie("chair", club)).toBe("president");
    expect(isRoleOf(club, "president")).toBe(true);
    expect(isRoleOf(club, "chair")).toBe(false);
    expect(isRoleOf(club, 7)).toBe(false);
  });

  it("role holders are matched to person records by full name; the leaver also by the leaver's name", () => {
    const people: Person[] = [
      { id: "p-1", displayName: "Priya Nair", emailHmac: "h", aliases: [] },
      { id: "p-2", displayName: "Rohan Mehta", emailHmac: "h", aliases: [] },
      { id: "p-11", displayName: "rohan  mehta", emailHmac: null, aliases: [] },
      { id: "p-14", displayName: "Priya", emailHmac: null, aliases: [] },
      { id: "p-4", displayName: "A. Rao", emailHmac: null, aliases: ["Arjun Rao"] },
      { id: "p-5", displayName: "Kabir Sethi", emailHmac: null, aliases: [] },
      { id: "p-6", displayName: "Rohan", emailHmac: null, aliases: [] },
    ];
    const got = matchRoleHolders(club, people).map((m) => `${m.roleKey}:${m.personId}`).sort();
    expect(got).toEqual(["leaver:p-1", "leaver:p-14", "president:p-11", "president:p-2", "tech_lead:p-4"]);
  });
});

describe("the trust ladder, written once", () => {
  it("ranks Successor found just below Leaver said and above Second-hand", () => {
    expect(TRUST_ORDER).toEqual([
      "from_record", "corroborated", "leaver_said", "successor_found", "second_hand", "inferred", "ranked_options",
    ]);
    expect(TRUST_LABEL.successor_found).toBe("Successor found");
    expect(strongestTrust(["second_hand", "successor_found"])).toBe("successor_found");
    expect(strongestTrust(["leaver_said", "successor_found"])).toBe("leaver_said");
    expect(weakestTrust(["leaver_said", "successor_found"])).toBe("successor_found");
    expect(weakestTrust(["successor_found", "second_hand"])).toBe("second_hand");
  });

  it("a successor finding covers a check (C) but is never a record (K)", () => {
    expect(STRONG_TRUST.has("successor_found")).toBe(true);
    expect(RECORD_TRUST.has("successor_found")).toBe(false);
    expect(STRONG_TRUST.has("second_hand")).toBe(false);
  });

  it("every module shares the one list", async () => {
    const relay = await import("@/lib/relay/core/labels");
    const lacuna = await import("@/lib/lacuna/core/pack");
    const support = await import("@/lib/attest/core/support");
    expect(relay.TRUST_ORDER).toBe(TRUST_ORDER);
    expect(relay.TRUST_LABEL).toBe(TRUST_LABEL);
    expect(lacuna.TRUST_ORDER).toBe(TRUST_ORDER);
    expect(lacuna.STRONG_TRUST).toBe(STRONG_TRUST);
    expect(support.weakerTrust("leaver_said", "successor_found")).toBe("successor_found");
    expect(support.weakerTrust("successor_found", "second_hand")).toBe("second_hand");
  });
});
