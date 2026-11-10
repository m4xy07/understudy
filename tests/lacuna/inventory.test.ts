import { describe, expect, it } from "vitest";
import { buildInventory, guessKind, isOpenOrRecent, matchEntity, type FootprintCandidate } from "@/lib/lacuna/core/inventory";
import { checksFor, DEFAULT_CHECKLISTS } from "@/lib/lacuna/core/checks";
import { pack, task } from "./fixtures";

const TODAY = "2026-11-11";

function build(tasks = [] as ReturnType<typeof task>[], footprint: FootprintCandidate[] = [], p = pack) {
  return buildInventory({ workspaceId: "ws", tasks, footprint, pack: p, successorRole: "new_member", today: TODAY });
}

describe("board items", () => {
  it("keeps open cards and done cards updated within 30 days, drops older done cards", () => {
    expect(isOpenOrRecent(task({ id: "1", title: "x", status: "In progress" }), TODAY)).toBe(true);
    expect(isOpenOrRecent(task({ id: "2", title: "x", status: "Done", updated_at: "2026-10-20" }), TODAY)).toBe(true);
    expect(isOpenOrRecent(task({ id: "3", title: "x", status: "done", updated_at: "2026-09-01" }), TODAY)).toBe(false);
    const inv = build([
      task({ id: "1", title: "Fix gripper jam", status: "open" }),
      task({ id: "3", title: "Old poster", status: "Done", updated_at: "2026-08-01" }),
    ]);
    expect(inv.map((r) => r.entities[0])).toEqual(["task-1"]);
  });

  it("groups cards by pack entity alias in title or labels; unmatched cards keep task-<id>", () => {
    const inv = build([
      task({ id: "11", title: "Flash new firmware before regionals", labels: "deploy" }),
      task({ id: "12", title: "Write CI notes", labels: ["firmware"] }),
      task({ id: "13", title: "Fix gripper jam" }),
    ]);
    const fw = inv.find((r) => r.entities.includes("firmware-deploy"))!;
    expect(fw.originDetail).toContain("cards 11, 12");
    expect(fw.title).toBe("Firmware deploy to the robot");
    expect(inv.find((r) => r.entities[0] === "task-13")?.title).toBe("Fix gripper jam");
    expect(matchEntity("Book the workshop lab", pack.entities)?.key).toBe("lab-booking");
    expect(matchEntity("nothing here", pack.entities)).toBeNull();
  });

  it("guesses kinds from labels and keywords", () => {
    expect(guessKind("Deploy to robot infra")).toBe("deploy_operate");
    expect(guessKind("email sponsor")).toBe("external_relationship");
    expect(guessKind("vendor quote")).toBe("external_relationship");
    expect(guessKind("Renew domain")).toBe("recurring_obligation");
    expect(guessKind("pay the monthly fee")).toBe("recurring_obligation");
    expect(guessKind("Book room for spring term")).toBe("recurring_obligation");
    expect(guessKind("Choose venue for showcase")).toBe("open_decision");
    expect(guessKind("Fix gripper jam")).toBeNull();
    const inv = build([
      task({ id: "1", title: "Thank Acme", labels: "sponsor" }),
      task({ id: "2", title: "Decide on chassis supplier vote" }),
      task({ id: "3", title: "Fix gripper jam" }),
    ]);
    expect(inv.find((r) => r.entities[0] === "sponsor-acme")?.kind).toBe("external_relationship");
    expect(inv.find((r) => r.entities[0] === "task-3")?.kind).toBe("unfinished_work");
  });

  it("applies the pack kind override map", () => {
    const p = { ...pack, kindOverrides: { "task-3": "open_decision" as const, "sponsor-acme": "unfinished_work" as const } };
    const inv = build([task({ id: "3", title: "Fix gripper jam" }), task({ id: "4", title: "Acme sponsor call" })], [], p);
    expect(inv.find((r) => r.entities[0] === "task-3")?.kind).toBe("open_decision");
    expect(inv.find((r) => r.entities[0] === "sponsor-acme")?.kind).toBe("unfinished_work");
  });

  it("takes the earliest due date of open cards", () => {
    const inv = build([
      task({ id: "1", title: "Flash firmware", due: "2026-12-01" }),
      task({ id: "2", title: "Deploy fix", due: "2026-11-20" }),
    ]);
    expect(inv[0].dueDate).toBe("2026-11-20");
  });
});

describe("footprint and role template items", () => {
  it("adds footprint items with the rule as origin detail", () => {
    const inv = build([], [{ entityKey: "competition", rule: "repeat_action", evidenceSegmentIds: ["seg_a"], detail: "4 times over 3 weeks" }]);
    expect(inv).toHaveLength(1);
    expect(inv[0].origin).toBe("footprint");
    expect(inv[0].originDetail).toContain("repeat_action");
    expect(inv[0].title).toBe("Regional competition");
  });

  it("guesses footprint kinds from the rule", () => {
    const inv = build([], [
      { entityKey: "mentor-ravi", rule: "sole_contact", evidenceSegmentIds: [], detail: "Only Priya talks to Ravi" },
      { entityKey: "domain-renewal", rule: "schedule", evidenceSegmentIds: [], detail: "yearly renewal" },
    ]);
    expect(inv.find((r) => r.entities[0] === "mentor-ravi")?.kind).toBe("external_relationship");
    expect(inv.find((r) => r.entities[0] === "domain-renewal")?.kind).toBe("recurring_obligation");
  });

  it("adds the successor's role template items only", () => {
    const inv = buildInventory({ workspaceId: "ws", tasks: [], footprint: [], pack, successorRole: "tech_lead", today: TODAY });
    expect(inv.map((r) => r.title).sort()).toEqual(["Book the workshop lab each term", "Keep the parts inventory"]);
    expect(inv.every((r) => r.origin === "role_template")).toBe(true);
  });

  it("merges duplicates by entity, keeps the strongest origin and lists all origins", () => {
    const inv = buildInventory({
      workspaceId: "ws",
      tasks: [task({ id: "21", title: "Lab slot for spring", due: "2026-11-30" })],
      footprint: [{ entityKey: "lab-booking", rule: "schedule", evidenceSegmentIds: ["seg_b"], detail: "each term" }],
      pack, successorRole: "tech_lead", today: TODAY,
    });
    const lab = inv.filter((r) => r.entities.includes("lab-booking"));
    expect(lab).toHaveLength(1);
    expect(lab[0].origin).toBe("task_board");
    expect(lab[0].originDetail).toBe("Task board: card 21 · Footprint: schedule · Role template: R03");
    expect(lab[0].title).toBe("Book the workshop lab each term");
    expect(lab[0].kind).toBe("recurring_obligation");
    expect(lab[0].dueDate).toBe("2026-11-30");
  });
});

describe("keys and order", () => {
  it("numbers R01.. with blocking-heavy kinds first, then due date; unconfirmed; stable ids", () => {
    const tasks = [
      task({ id: "1", title: "Fix gripper jam", due: "2026-11-15" }),
      task({ id: "2", title: "Renew club domain", due: "2026-12-20" }),
      task({ id: "3", title: "Renew insurance", due: "2026-11-18" }),
      task({ id: "4", title: "Flash firmware", due: "2027-01-10" }),
    ];
    const inv = build(tasks);
    expect(inv.map((r) => r.key)).toEqual(["R01", "R02", "R03", "R04"]);
    expect(inv[0].kind).toBe("deploy_operate"); // two blocking checks
    // same blocking weight: kind order, then due date
    expect(inv.slice(1).map((r) => r.entities[0])).toEqual(["task-3", "task-2", "task-1"]);
    expect(inv.every((r) => r.confirmed === false)).toBe(true);
    expect(build(tasks).map((r) => r.id)).toEqual(inv.map((r) => r.id));
    expect(inv[0].id).toMatch(/^resp_[0-9a-f]{16}$/);
  });
});

describe("checks", () => {
  it("returns the contract checklist per kind, with pack override", () => {
    const deploy = checksFor({ kind: "deploy_operate" }, pack);
    expect(deploy.map((c) => [c.key, c.wTag, c.weight])).toEqual([
      ["access_path", "WHERE", 3], ["steps", "HOW", 3], ["verify", "HOW", 3], ["rollback", "HOW", 5], ["credential_owner", "WHO", 5],
    ]);
    expect(checksFor({ kind: "external_relationship" }).map((c) => c.weight)).toEqual([5, 1, 3, 3]);
    expect(checksFor({ kind: "recurring_obligation" }).map((c) => c.weight)).toEqual([3, 5, 3, 1]);
    expect(checksFor({ kind: "open_decision" }).map((c) => c.weight)).toEqual([3, 1, 5, 3]);
    expect(checksFor({ kind: "unfinished_work" }).map((c) => c.weight)).toEqual([3, 3, 5, 1]);
    for (const list of Object.values(DEFAULT_CHECKLISTS)) for (const c of list) expect(c.attributes.length).toBeGreaterThan(0);
    const custom = checksFor({ kind: "open_decision" }, {
      ...pack,
      checklists: { open_decision: [{ key: "x", label: "X", wTag: "WHO", weight: 5, attributes: ["owner"] }] },
    });
    expect(custom.map((c) => c.key)).toEqual(["x"]);
  });
});
