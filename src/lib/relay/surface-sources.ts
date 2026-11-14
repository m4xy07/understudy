// Surfaces other modules own, for the leak check grid (src/lib/relay/surfaces.ts).
//
// This is the one place to wire them in. Until a function is set here its columns read
// "Not built" and are left out of the pass count, so this work merges in any order.
//
// At merge, replace the `undefined` with the real function:
//
//   import { recoverySurfaces } from "@/lib/lacuna/recovery";   // recovery (improvement 1)
//   import { changeTexts } from "@/lib/relay/living";           // living handover (improvement 3)
//
//   recoverySurfaces(ws, role) returns Surface[] whose `surface` is one of
//     "graph", "neighbour_questions", "traces", "ranked_options"
//   and holds exactly the strings the Ask page renders for that role.
//   changeTexts(ws, role) returns every string the "What changed" panels show that role.
import type { RoleKey } from "@/lib/types";
import type { Surface } from "./core/canary";

export interface ExternalSurfaceSources {
  recoverySurfaces?: (ws: string, role: RoleKey) => Promise<Surface[]>;
  changeTexts?: (ws: string, role: RoleKey) => Promise<string[]>;
}

export const EXTERNAL_SURFACES: ExternalSurfaceSources = {
  recoverySurfaces: undefined,
  changeTexts: undefined,
};
