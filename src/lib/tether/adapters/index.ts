// Adapter entry point (pure, no DB). ARCHITECTURE section 7a.
import type { AdapterResult, SourceKind } from "@/lib/types";
import type { AdapterContext, SourceFile } from "./common";
import { parseGithub } from "./github";
import { parseIcs } from "./ics";
import { parseMarkdown } from "./markdown";
import { parseSlack } from "./slack";
import { parseTasks } from "./tasks";
import { parseWhatsapp } from "./whatsapp";

export type { AdapterContext, SourceFile } from "./common";
export { parseGithub, parseIcs, parseMarkdown, parseSlack, parseTasks, parseWhatsapp };

export function parseSource(kind: SourceKind, files: SourceFile[], ctx: AdapterContext): AdapterResult {
  switch (kind) {
    case "whatsapp":
      return parseWhatsapp(files, ctx);
    case "slack":
      return parseSlack(files, ctx);
    case "github":
      return parseGithub(files, ctx);
    case "tasks_csv":
      return parseTasks(files, ctx);
    case "markdown":
      return parseMarkdown(files, ctx);
    case "ics":
      return parseIcs(files, ctx);
    case "interview":
      throw new Error("interview segments are created from gap answers, not imported");
    case "finding":
      throw new Error("finding segments are created from successor findings, not imported");
    default: {
      const never: never = kind;
      throw new Error(`unknown source kind: ${String(never)}`);
    }
  }
}
