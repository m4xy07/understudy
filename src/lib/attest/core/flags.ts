// Flag visibility: who may see a claim that takes part in a conflict or a supersession. Pure.
// Contract: docs/ARCHITECTURE.md section 4a, docs/round3/specs/02_confidentiality.md section 10.
//
// Rule: a role sees a conflict only if it can see every claim in it. Otherwise it sees none of
// them. Showing the visible side without its flag would let the role act on a value the record
// disputes; showing the flag would tell the role that a hidden claim exists and disagrees.
// The same holds for a superseded claim: its "Superseded" note and link point at the winner, so
// a role that cannot see the winner does not see the superseded claim either.
//
// The result is stored in claims.flag_role_set and enforced by RLS (us_can_see). null means
// "nothing extra to hide": the claim's own role set decides.
import type { Claim, RoleKey } from "@/lib/types";
import type { RuleFiring } from "./rules";

type FlagClaim = Pick<Claim, "id" | "roleSet">;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
const intersect = (a: readonly RoleKey[], b: readonly RoleKey[]) => a.filter((r) => b.includes(r));

export function flagRoleSets(claims: readonly FlagClaim[], firings: readonly RuleFiring[]): Map<string, RoleKey[] | null> {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const flags = new Map<string, RoleKey[] | null>(claims.map((c) => [c.id, null]));

  // Conflicts (rules 3 and 4): connected components over the firings.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  for (const f of firings) {
    if (f.rule < 3 || !byId.has(f.olderId) || !byId.has(f.newerId)) continue;
    parent.set(find(f.olderId), find(f.newerId));
  }
  const components = new Map<string, string[]>();
  for (const f of firings) {
    if (f.rule < 3) continue;
    for (const id of [f.olderId, f.newerId]) {
      if (!byId.has(id)) continue;
      const root = find(id);
      const list = components.get(root) ?? [];
      if (!list.includes(id)) list.push(id);
      components.set(root, list);
    }
  }
  for (const members of components.values()) {
    let shared: RoleKey[] = [...byId.get(members[0])!.roleSet];
    for (const id of members.slice(1)) shared = intersect(shared, byId.get(id)!.roleSet);
    for (const id of members) flags.set(id, sameSet(shared, byId.get(id)!.roleSet) ? null : shared);
  }

  // Supersession (rules 1 and 2): the loser is cut down to the roles that can see the winner.
  // Repeated until stable, so a chain (A superseded by B, B superseded by C) carries through.
  const effective = (id: string): RoleKey[] => flags.get(id) ?? byId.get(id)!.roleSet;
  const wins = firings.filter((f) => f.rule <= 2 && byId.has(f.olderId) && byId.has(f.newerId));
  for (let pass = 0; pass <= wins.length; pass++) {
    let changed = false;
    for (const f of wins) {
      const own = effective(f.olderId);
      const next = intersect(own, effective(f.newerId));
      if (sameSet(next, own)) continue;
      flags.set(f.olderId, next);
      changed = true;
    }
    if (!changed) break;
  }
  return flags;
}
