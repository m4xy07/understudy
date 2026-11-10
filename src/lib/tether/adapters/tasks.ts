// Task board CSV, header exactly: id,title,status,owner,owner_email,due,labels,updated_at,description
import Papa from "papaparse";
import type { AdapterResult } from "@/lib/types";
import { parseDateLoose } from "../ids";
import { basename, EPOCH_IST, ResultBuilder, stripBom, type AdapterContext, type SourceFile } from "./common";

export const TASKS_HEADER = ["id", "title", "status", "owner", "owner_email", "due", "labels", "updated_at", "description"] as const;
type Row = Record<(typeof TASKS_HEADER)[number], string | undefined>;

export function parseTasks(files: SourceFile[], ctx: AdapterContext): AdapterResult {
  const b = new ResultBuilder(ctx, "tasks_csv");
  for (const file of files) {
    if (!/\.csv$/i.test(file.path) && files.length > 1) continue;
    const thread = basename(file.path).replace(/\.csv$/i, "");
    const parsed = Papa.parse<Row>(stripBom(file.content), {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => h.trim(),
    });
    const fields = (parsed.meta.fields ?? []).map((f) => f.trim());
    if (fields.join(",") !== TASKS_HEADER.join(",")) {
      b.reject(1, fields.join(","), `header must be exactly: ${TASKS_HEADER.join(",")}`);
      continue;
    }
    const badRows = new Map<number, string>();
    for (const err of parsed.errors) {
      if (typeof err.row === "number") badRows.set(err.row, `${err.code}: ${err.message}`);
    }
    parsed.data.forEach((row, i) => {
      const line = i + 2; // header is line 1
      const raw = TASKS_HEADER.map((k) => row[k] ?? "").join(",");
      const parseErr = badRows.get(i);
      if (parseErr) return b.reject(line, raw, `malformed CSV row (${parseErr})`);
      const id = (row.id ?? "").trim();
      const title = (row.title ?? "").trim();
      if (!id) return b.reject(line, raw, "missing id");
      if (!title) return b.reject(line, raw, `task ${id}: missing title`);
      const dueRaw = (row.due ?? "").trim();
      const due = dueRaw ? parseDateLoose(dueRaw) : null;
      if (dueRaw && !due) return b.reject(line, raw, `task ${id}: bad due date "${dueRaw}"`);
      const updRaw = (row.updated_at ?? "").trim();
      const updatedAt = updRaw ? parseDateLoose(updRaw) : null;
      if (updRaw && !updatedAt) return b.reject(line, raw, `task ${id}: bad updated_at "${updRaw}"`);

      const ownerName = (row.owner ?? "").trim();
      const ownerEmail = (row.owner_email ?? "").trim();
      const owner = ownerName || ownerEmail
        ? ctx.people.resolve({ displayName: b.mask(ownerName || "unknown"), email: ownerEmail || null, scope: ctx.sourceId })
        : null;
      b.touch(owner?.id);
      const status = (row.status ?? "").trim();
      const labels = (row.labels ?? "").split(/[;,|]/).map((l) => l.trim()).filter(Boolean);
      const mTitle = b.mask(title);
      const mOwner = owner ? owner.displayName : "";
      const mDesc = b.mask((row.description ?? "").trim());
      const dueDate = due ? due.slice(0, 10) : "";
      const text =
        `Task ${id}: ${mTitle} | status: ${status || "none"} | owner: ${mOwner || "unassigned"} | ` +
        `due: ${dueDate || "none"} | labels: ${labels.join(", ") || "none"}` + (mDesc ? ` | ${mDesc}` : "");
      b.add({
        kind: "task",
        ts: updatedAt ?? due ?? EPOCH_IST,
        thread,
        // already masked above; masking again is a no-op on placeholders
        rawText: text,
        authorId: null, // the board has no author; the owner is in meta
        meta: {
          taskId: id,
          title: mTitle,
          status,
          owner: mOwner || null,
          ownerId: owner?.id ?? null,
          due: dueDate || null,
          labels,
          updatedAt: updatedAt ?? null,
          description: mDesc || null,
        },
      });
    });
  }
  return b.result();
}
