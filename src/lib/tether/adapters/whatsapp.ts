// WhatsApp Android export: `dd/mm/yy, hh:mm - Name: text` (also dd/mm/yyyy, 12-hour h:mm am/pm,
// and the iOS bracket form `[dd/mm/yy, hh:mm:ss] Name: text`). Continuation lines belong to the
// previous message. System lines (no `Name:`) are skipped. Times are IST (+05:30).
import type { AdapterResult } from "@/lib/types";
import { istWallClock } from "../ids";
import { basename, ResultBuilder, stripBom, type AdapterContext, type SourceFile } from "./common";

const ANDROID =
  /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[\s  ]*([aApP])\.?\s*[mM]\.?)?\s+[-–]\s+([\s\S]*)$/;
const IOS =
  /^‎?\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[\s  ]*([aApP])\.?\s*[mM]\.?)?\]\s+([\s\S]*)$/;
const LOOKS_LIKE_TIMESTAMP = /^‎?\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/;
const SKIP_BODIES = /^(<media omitted>|this message was deleted|you deleted this message|null)$/i;

interface Msg {
  line: number;
  ts: string;
  name: string;
  lines: string[];
}

export function chatName(path: string): string {
  return basename(path).replace(/\.txt$/i, "");
}

function parseHeader(line: string): { ts: string | null; rest: string } | null {
  const m = ANDROID.exec(line) ?? IOS.exec(line);
  if (!m) return null;
  const d = +m[1];
  const mo = +m[2];
  let y = +m[3];
  if (m[3].length === 2) y += 2000;
  let h = +m[4];
  const mi = +m[5];
  const s = m[6] ? +m[6] : 0;
  const ampm = m[7]?.toLowerCase();
  if (ampm) {
    if (h < 1 || h > 12) return { ts: null, rest: m[8] };
    if (ampm === "p" && h !== 12) h += 12;
    if (ampm === "a" && h === 12) h = 0;
  }
  return { ts: istWallClock(y, mo, d, h, mi, s), rest: m[8] };
}

export function parseWhatsapp(files: SourceFile[], ctx: AdapterContext): AdapterResult {
  const b = new ResultBuilder(ctx, "whatsapp");
  for (const file of files) {
    if (!/\.txt$/i.test(file.path) && files.length > 1) continue;
    const thread = chatName(file.path);
    const lines = stripBom(file.content).replace(/\r\n?/g, "\n").split("\n");
    const msgs: Msg[] = [];
    let current: Msg | null = null;
    let lastWasSystem = false;

    lines.forEach((raw, i) => {
      const lineNo = i + 1;
      const line = raw.replace(/^‎/, "");
      const header = parseHeader(line);
      if (header) {
        if (!header.ts) {
          b.reject(lineNo, line, "invalid date or time in message header");
          current = null;
          lastWasSystem = true;
          return;
        }
        const sep = header.rest.indexOf(": ");
        if (sep <= 0) {
          current = null; // system line ("X joined", "Messages are end-to-end encrypted")
          lastWasSystem = true;
          return;
        }
        current = { line: lineNo, ts: header.ts, name: header.rest.slice(0, sep).trim(), lines: [header.rest.slice(sep + 2)] };
        msgs.push(current);
        lastWasSystem = false;
        return;
      }
      if (current) {
        current.lines.push(line);
        return;
      }
      if (line.trim() === "") return;
      if (lastWasSystem) return; // continuation of a skipped system line
      b.reject(
        lineNo,
        line,
        LOOKS_LIKE_TIMESTAMP.test(line)
          ? "unrecognised WhatsApp timestamp format (expected dd/mm/yy, hh:mm - Name: text)"
          : "text before the first message line (not a WhatsApp export line)",
      );
    });

    for (const m of msgs) {
      const text = m.lines.join("\n").trim();
      if (!text || SKIP_BODIES.test(text)) continue;
      // unknown contacts appear as phone numbers: never keep a raw number as a display name
      const displayName = b.mask(m.name);
      const person = ctx.people.resolve({ displayName, scope: ctx.sourceId });
      b.add({
        kind: "message",
        ts: m.ts,
        thread,
        rawText: text,
        authorId: person.id,
        meta: { chat: thread, line: m.line },
      });
    }
  }
  return b.result();
}
