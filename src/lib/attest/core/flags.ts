// Flag visibility: who may see a claim that takes part in a conflict or a supersession. Pure.
// Contract: docs/ARCHITECTURE.md section 4a, docs/round3/specs/02_confidentiality.md section 10.
//
// Rule: a role sees a conflicting claim only if it can also see a claim it conflicts with.
// A claim whose every counterpart is hidden from the role is hidden too: showing it without its
// flag would let the role act on a value the record disputes, and showing the flag would tell
// the role that a hidden claim exists and disagrees. With two sides this is "the role sees a
// conflict only if it can see every side". With more sides, a role that can read two of them
// still sees those two as a conflict (each explains the other's flag); a further hidden side
// adds nothing the role can notice.
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

  // Conflicts (rules 3 and 4): a claim is cut down to the roles that can read at least one of the
  // claims it conflicts with.
  const counterparts = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = counterparts.get(a) ?? new Set<string>();
    set.add(b);
    counterparts.set(a, set);
  };
  for (const f of firings) {
    if (f.rule < 3 || !byId.has(f.olderId) || !byId.has(f.newerId)) continue;
    link(f.olderId, f.newerId);
    link(f.newerId, f.olderId);
  }
  for (const [id, others] of counterparts) {
    const own = byId.get(id)!.roleSet;
    const explained = new Set<RoleKey>();
    for (const o of others) for (const r of byId.get(o)!.roleSet) explained.add(r);
    const shared = own.filter((r) => explained.has(r));
    flags.set(id, sameSet(shared, own) ? null : shared);
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
