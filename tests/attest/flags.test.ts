// Flag visibility for conflicts and supersessions. Spec 02 section 14, tests T18 to T22.
// The pure part needs nothing; the database part needs a migrated database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { countWithheld, listClaims } from "@/lib/db/queries";
import { reconstruct, verify } from "@/lib/attest";
import { flagRoleSets } from "@/lib/attest/core/flags";
import { claimMeta } from "@/lib/lacuna";
import { createEmptyWorkspace, ingestSources } from "@/lib/pipeline/ingest";
import { compileHandover, reviewClaim } from "@/lib/relay";
import type { RoleKey } from "@/lib/types";
import { CLUB, CLUB_ID } from "../helpers/club";

const ALL: RoleKey[] = [...CLUB.roleOrder];
const FINANCE: RoleKey[] = ["president", "treasurer", "leaver"];
const OUTSIDE = ALL.filter((r) => !FINANCE.includes(r));

describe("flagRoleSets (pure)", () => {
  const c = (id: string, roleSet: RoleKey[]) => ({ id, roleSet });

  it("T18: a conflict whose sides share one role set needs no flag", () => {
    const flags = flagRoleSets([c("a", ALL), c("b", ALL)], [{ rule: 3, olderId: "a", newerId: "b" }]);
    expect(flags.get("a")).toBeNull();
    expect(flags.get("b")).toBeNull();
  });

  it("T19: one hidden side hides every side from the roles that cannot see them all", () => {
    const flags = flagRoleSets([c("open", ALL), c("fin", FINANCE)], [{ rule: 3, olderId: "fin", newerId: "open" }]);
    expect(flags.get("open")).toEqual(FINANCE);
    expect(flags.get("fin")).toBeNull();   // its own role set already equals the shared one
  });

  it("with more than two sides, each claim is visible to the roles that can read one of its counterparts", () => {
    const b: RoleKey[] = ["president", "tech_lead", "leaver"];
    const flags = flagRoleSets(
      [c("a", ALL), c("b", b), c("d", FINANCE)],
      [{ rule: 3, olderId: "a", newerId: "b" }, { rule: 4, olderId: "b", newerId: "d" }],
    );
    expect(flags.get("a")).toEqual(b);                       // a conflicts with b only
    expect(flags.get("b")).toBeNull();                       // every role of b reads a
    expect(flags.get("d")).toEqual(["president", "leaver"]); // d conflicts with b only
    // No role is left looking at a conflicting claim with no visible counterpart.
    const claims = [c("a", ALL), c("b", b), c("d", FINANCE)];
    const edges: [string, string][] = [["a", "b"], ["b", "d"]];
    for (const role of ALL) {
      const sees = (id: string) => (flags.get(id) ?? claims.find((x) => x.id === id)!.roleSet).includes(role);
      for (const x of claims) {
        if (!sees(x.id)) continue;
        const others = edges.filter((e) => e.includes(x.id)).map((e) => (e[0] === x.id ? e[1] : e[0]));
        expect(others.some(sees), `${role} sees ${x.id} with a counterpart`).toBe(true);
      }
    }
  });

  it("an open conflict keeps showing when a further, hidden claim also disagrees", () => {
    // Two open sides conflict with each other; a third, approver-only claim conflicts with both.
    const flags = flagRoleSets(
      [c("a", ALL), c("b", ALL), c("h", ["president"])],
      [{ rule: 3, olderId: "a", newerId: "b" }, { rule: 3, olderId: "a", newerId: "h" }, { rule: 3, olderId: "b", newerId: "h" }],
    );
    expect(flags.get("a")).toBeNull();
    expect(flags.get("b")).toBeNull();
    expect(flags.get("h")).toBeNull();
  });

  it("two open claims that agree, both disputed only by a hidden one, are hidden from the roles that cannot read it", () => {
    const flags = flagRoleSets(
      [c("a", ALL), c("b", ALL), c("h", FINANCE)],
      [{ rule: 3, olderId: "a", newerId: "h" }, { rule: 3, olderId: "b", newerId: "h" }],
    );
    expect(flags.get("a")).toEqual(FINANCE);
    expect(flags.get("b")).toEqual(FINANCE);
  });

  it("T20: a superseded claim whose winner is hidden is hidden from that role too", () => {
    const flags = flagRoleSets([c("old", ALL), c("new", FINANCE)], [{ rule: 1, olderId: "old", newerId: "new" }]);
    expect(flags.get("old")).toEqual(FINANCE);
    expect(flags.get("new")).toBeNull();   // the winner is untouched
  });

  it("a chain of supersessions carries the hiding through", () => {
    const flags = flagRoleSets(
      [c("a", ALL), c("b", ALL), c("d", FINANCE)],
      [{ rule: 2, olderId: "a", newerId: "b" }, { rule: 1, olderId: "b", newerId: "d" }],
    );
    expect(flags.get("b")).toEqual(FINANCE);
    expect(flags.get("a")).toEqual(FINANCE);
  });

  it("a winner that is itself in a hidden-side conflict passes that on to what it superseded", () => {
    const flags = flagRoleSets(
      [c("old", ALL), c("x", ALL), c("y", FINANCE)],
      [{ rule: 1, olderId: "old", newerId: "x" }, { rule: 3, olderId: "x", newerId: "y" }],
    );
    expect(flags.get("x")).toEqual(FINANCE);
    expect(flags.get("old")).toEqual(FINANCE);
  });

  it("claims outside any firing, and firings that name unknown claims, change nothing", () => {
    const flags = flagRoleSets([c("a", ALL), c("b", FINANCE)], [{ rule: 3, olderId: "a", newerId: "gone" }]);
    expect(flags.get("a")).toBeNull();
    expect(flags.get("b")).toBeNull();
  });

  it("a flag never holds a role the claim itself lacks", () => {
    const flags = flagRoleSets([c("a", ["president", "tech_lead"]), c("b", ["president", "treasurer"])], [{ rule: 3, olderId: "a", newerId: "b" }]);
    for (const id of ["a", "b"]) expect(flags.get(id)).toEqual(["president"]);
  });
});

describe("flag visibility in the database (case D shape)", () => {
  const sql = db();
  let ws = "";
  let openId = "";
  let hiddenId = "";
  let plainId = "";

  const slack = (channel: string, text: string, ts: string, user: string) => [
    { path: "users.json", content: JSON.stringify([{ id: "U1", real_name: "Ananya Iyer", profile: { email: "ananya@example.org" } }, { id: "U2", real_name: "Dev Malhotra", profile: { email: "dev@example.org" } }]) },
    { path: `${channel}.json`, content: JSON.stringify([{ ts, user, text }]) },
  ];

  beforeAll(async () => {
    ws = await createEmptyWorkspace("flags fixture", CLUB_ID);
    await ingestSources(ws, [
      { kind: "slack", name: "Slack #events", roleSet: ALL, files: slack("events", "Organisers say the competition entry fee has to be paid by 28 Nov 2026. Venue is Hall B.", "1793600000.000100", "U2") },
      { kind: "slack", name: "Slack #finance", roleSet: FINANCE, files: slack("finance", "The competition entry fee must be paid by 25 Nov 2026.", "1792500000.000100", "U1") },
    ], "upload", { sensitivityCall: null });
    const segs = await sql`SELECT id, text, role_set FROM segments WHERE workspace_id = ${ws}`;
    const idOf = (needle: string) => String(segs.find((s) => String(s.text).includes(needle))!.id);
    const open = idOf("28 Nov");
    const hidden = idOf("25 Nov");
    // The open message is not sensitive: a fee deadline with no amount and no person.
    expect(segs.find((s) => s.id === open)!.role_set).toEqual(ALL);
    const fake = async (o: { user: string }) => ({
      ok: true as const, cached: false,
      data: {
        claims: [
          ...(o.user.includes(open) ? [
            { entity: "entry-fee", attribute: "deadline", value: "2026-11-28", statement: "The entry fee must be paid by 28 Nov 2026.", citations: [{ segment_id: open, quote: "has to be paid by 28 Nov 2026" }] },
            { entity: "competition", attribute: "location", value: "Hall B", statement: "The venue is Hall B.", citations: [{ segment_id: open, quote: "Venue is Hall B" }] },
          ] : []),
          ...(o.user.includes(hidden) ? [
            { entity: "entry-fee", attribute: "deadline", value: "2026-11-25", statement: "The entry fee must be paid by 25 Nov 2026.", citations: [{ segment_id: hidden, quote: "must be paid by 25 Nov 2026" }] },
          ] : []),
        ],
      },
    });
    await reconstruct(ws, { call: fake as never });
    await verify(ws, { support: false });
    const claims = await listClaims(ws);
    openId = claims.find((c) => c.value === "2026-11-28")!.id;
    hiddenId = claims.find((c) => c.value === "2026-11-25")!.id;
    plainId = claims.find((c) => c.attribute === "location")!.id;
  }, 60_000);

  afterAll(async () => {
    if (ws) {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('us.allow_purge', 'on', true)`;
        await tx`DELETE FROM workspaces WHERE id = ${ws}`;
      });
    }
    await sql.end();
  });

  it("verify marks both sides conflicting and writes the flag on the open side", async () => {
    const claims = await listClaims(ws);
    const open = claims.find((c) => c.id === openId)!;
    const hidden = claims.find((c) => c.id === hiddenId)!;
    expect(open.state).toBe("conflicting");
    expect(hidden.state).toBe("conflicting");
    expect(open.roleSet).toEqual(ALL);
    expect(open.flagRoleSet).toEqual(FINANCE);
    expect(hidden.flagRoleSet).toBeNull();
    expect(claims.find((c) => c.id === plainId)!.flagRoleSet).toBeNull();
  });

  it("T19: a role that sees one side gets no claim row and no conflict text; roles that see both get both", async () => {
    for (const role of OUTSIDE) {
      const seen = await listClaims(ws, { role });
      expect(seen.map((c) => c.id)).toEqual([plainId]);
      expect(JSON.stringify(seen)).not.toMatch(/Conflicting|28 Nov|2026-11-28|25 Nov/);
    }
    for (const role of FINANCE) {
      const seen = (await listClaims(ws, { role })).map((c) => c.id).sort();
      expect(seen).toEqual([openId, hiddenId, plainId].sort());
    }
  });

  it("T21: the reader policy, claim_meta and count_withheld agree for every claim and role", async () => {
    const admin = await listClaims(ws);
    await sql`INSERT INTO snapshots (workspace_id, id, version, hash, approved_by, payload) VALUES (${ws}, 'snap_v1', 1, 'abc', ${CLUB.approverRole}, '{}'::jsonb)`;
    for (const c of admin) {
      await sql`INSERT INTO snapshot_claims (workspace_id, snapshot_id, claim_id, entity, attribute, statement, trust, state, role_set, flag_role_set)
        VALUES (${ws}, 'snap_v1', ${c.id}, ${c.entity}, ${c.attribute}, ${c.statement}, ${c.trust}, ${c.state === "conflicting" ? "conflicting" : "active"},
          ${c.roleSet}::text[], ${c.flagRoleSet ?? null}::text[])`;
    }
    for (const role of ALL) {
      const visible = new Set((await listClaims(ws, { role })).map((c) => c.id));
      const meta = await claimMeta(ws, role);
      for (const c of admin) {
        const [{ ok }] = await sql`SELECT us_can_see(${role}, ${c.roleSet}::text[], ${c.flagRoleSet ?? null}::text[]) AS ok`;
        expect(visible.has(c.id), `${role} ${c.value}`).toBe(Boolean(ok));
        expect(meta.get(c.id)!.roleSet.includes(role), `meta ${role} ${c.value}`).toBe(Boolean(ok));
      }
      const frozen = await withRole(ws, role, (tx) => tx`SELECT claim_id FROM snapshot_claims WHERE workspace_id = ${ws}`);
      expect(frozen.length).toBe(visible.size);
      expect(await countWithheld(ws, role)).toBe(admin.length - visible.size);
    }
    // The role that reads one side counts two restricted items: the hidden claim and the flagged one.
    expect(await countWithheld(ws, OUTSIDE[0])).toBe(2);
    const h = await compileHandover(ws, OUTSIDE[0]);
    expect(h.stubLine).toBe(`2 restricted items. Ask the approver (${h.approverLabel}).`);
    const lines = h.doc!.sections.flatMap((x) => x.lines.map((l) => l.text)).join("\n");
    expect(lines).not.toMatch(/28 Nov|2026-11-28|25 Nov|disagree|Conflicting/);
    expect(h.doc!.sections.flatMap((x) => x.lines).filter((l) => l.kind === "conflict")).toEqual([]);
  });

  it("T22: when the approver rejects one side, the other side is visible again after verify", async () => {
    const res = await reviewClaim(ws, hiddenId, "rejected", CLUB.approverRole, { note: "The organisers' mail is the newer word.", evidenceOpened: true });
    expect(res.ok).toBe(true);
    await verify(ws, { support: false });
    const open = (await listClaims(ws)).find((c) => c.id === openId)!;
    expect(open.state).toBe("active");
    expect(open.flagRoleSet).toBeNull();
    for (const role of OUTSIDE) {
      expect((await listClaims(ws, { role })).map((c) => c.id).sort()).toEqual([openId, plainId].sort());
    }
  });
});
