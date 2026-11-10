import { describe, expect, it } from "vitest";
import { buildInventory, expandEntities } from "@/lib/lacuna/core/inventory";
import type { LacunaPack } from "@/lib/lacuna/core/pack";
import { pack, task } from "./fixtures";

const TODAY = "2026-11-11";

const withParts: LacunaPack = {
  ...pack,
  entities: [
    ...pack.entities,
    { key: "firmware-rollback", label: "Firmware rollback", aliases: ["rollback"], partOf: "firmware-deploy" },
  ],
};

describe("part-of entities", () => {
  it("maps a part to its whole and brings the parts along with the whole", () => {
    expect(expandEntities(["firmware-rollback"], withParts.entities)).toEqual(["firmware-deploy", "firmware-rollback"]);
    expect(expandEntities(["firmware-deploy"], withParts.entities)).toEqual(["firmware-deploy", "firmware-rollback"]);
    expect(expandEntities(["competition"], withParts.entities)).toEqual(["competition"]);
  });

  it("merges a footprint hit on a part into the whole's responsibility, titled by the whole", () => {
    const inv = buildInventory({
      workspaceId: "ws",
      tasks: [],
      footprint: [
        { entityKey: "firmware-rollback", rule: "repeat", evidenceSegmentIds: ["seg_a"], detail: "4 times" },
        { entityKey: "firmware-deploy", rule: "ownership", evidenceSegmentIds: ["seg_b"], detail: "87% of commits" },
      ],
      pack: withParts, successorRole: "new_member", today: TODAY,
    });
    expect(inv).toHaveLength(1);
    expect(inv[0].title).toBe("Firmware deploy to the robot");
    expect(inv[0].entities).toEqual(["firmware-deploy", "firmware-rollback"]);
    expect(inv[0].kind).toBe("deploy_operate");
  });

  it("merges a board card about a part into the whole", () => {
    const inv = buildInventory({
      workspaceId: "ws",
      tasks: [task({ id: "9", title: "Write the rollback notes" })],
      footprint: [{ entityKey: "firmware-deploy", rule: "ownership", evidenceSegmentIds: ["seg_b"], detail: "87%" }],
      pack: withParts, successorRole: "new_member", today: TODAY,
    });
    expect(inv).toHaveLength(1);
    expect(inv[0].origin).toBe("task_board");
    expect(inv[0].entities).toContain("firmware-rollback");
  });

  it("changes nothing when the pack has no part-of links", () => {
    const inv = buildInventory({
      workspaceId: "ws", tasks: [],
      footprint: [{ entityKey: "competition", rule: "repeat", evidenceSegmentIds: [], detail: "x" }],
      pack, successorRole: "new_member", today: TODAY,
    });
    expect(inv[0].entities).toEqual(["competition"]);
  });
});
