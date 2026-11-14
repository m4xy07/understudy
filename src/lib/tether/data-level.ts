import type { SourceKind } from "@/lib/types";

export type DataLevel = "L0" | "L1" | "L2" | "L3";

export const DATA_LEVEL_LABEL: Record<DataLevel, string> = {
  L0: "No sources",
  L1: "Task board",
  L2: "Task board + chat or notes",
  L3: "Task board + chat or notes + code/config",
};

/**
 * Data level shown on Connect: L0 none, L1 task board, L2 + chat or notes, L3 + github.
 * Counted as layers present: structured board (tasks_csv or ics), talk (whatsapp, slack,
 * markdown), code/config (github). The full ladder gives the documented meaning; a partial mix
 * (e.g. chat + github, no board) still gets credit per layer. Answers and findings do not count.
 */
export function dataLevel(kinds: SourceKind[]): DataLevel {
  const k = new Set(kinds.filter((x) => x !== "interview" && x !== "finding"));
  const board = k.has("tasks_csv") || k.has("ics");
  const talk = k.has("whatsapp") || k.has("slack") || k.has("markdown");
  const code = k.has("github");
  const n = Number(board) + Number(talk) + Number(code);
  return (["L0", "L1", "L2", "L3"] as const)[n];
}
