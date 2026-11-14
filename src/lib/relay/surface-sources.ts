// Surfaces other modules own, for the leak check grid (src/lib/relay/surfaces.ts).
//
// This is the one place they are wired in. A function left undefined here makes its columns read
// "Not built" and leaves them out of the pass count.
//
//   recovery (improvement 1): recoverySurfaces(ws, role) from src/lib/lacuna/recovery.ts returns
//     exactly the strings the Ask page renders for that role while recovery is on, in four groups.
//     They are mapped to the grid's columns below. With recovery off it returns nothing, so the
//     columns are built and empty.
//   living handover (improvement 3): changeTexts(ws, role) is every string the "What changed"
//     panels show that role; firstWeeksTexts(ws, role) is every string the First weeks page shows
//     (gap rows with their plan, and the findings the role may see with their evidence). Both feed
//     the "changes" column.
//
// The functions are called lazily (inside the arrows), so the import cycle
// relay/index -> probes -> surfaces -> here -> relay/living -> relay/index is harmless.
import type { RoleKey } from "@/lib/types";
import { recoverySurfaces } from "@/lib/lacuna/recovery";
import type { Surface } from "./core/canary";
import { changeTexts, firstWeeksTexts } from "./living";

export interface ExternalSurfaceSources {
  recoverySurfaces?: (ws: string, role: RoleKey) => Promise<Surface[]>;
  changeTexts?: (ws: string, role: RoleKey) => Promise<string[]>;
}

/** Recovery's own group names -> the grid's column keys. An unknown group is checked under "graph". */
const RECOVERY_COLUMN: Record<string, "graph" | "neighbour_questions" | "traces" | "ranked_options"> = {
  "recovery neighbours": "graph",
  "recovery questions for this role": "neighbour_questions",
  "recovery traces": "traces",
  "recovery options": "ranked_options",
};

/** Recovery's surfaces under the grid's column keys; empty groups are dropped. */
export async function recoveryColumns(ws: string, role: RoleKey): Promise<Surface[]> {
  return (await recoverySurfaces(ws, role))
    .filter((s) => s.text.trim() !== "")
    .map((s) => ({ surface: RECOVERY_COLUMN[s.surface] ?? "graph", text: s.text }));
}

/** What changed (every version) and First weeks, as that role sees them. */
export async function livingTexts(ws: string, role: RoleKey): Promise<string[]> {
  const [changes, weeks] = await Promise.all([changeTexts(ws, role), firstWeeksTexts(ws, role)]);
  return [...changes, ...weeks].filter((t) => typeof t === "string" && t.trim() !== "");
}

export const EXTERNAL_SURFACES: ExternalSurfaceSources = {
  recoverySurfaces: (ws, role) => recoveryColumns(ws, role),
  changeTexts: (ws, role) => livingTexts(ws, role),
};
