import type { AdapterResult, ContactHit, RejectedRow, RoleKey, Segment, SegmentKind, SourceKind } from "@/lib/types";
import type { PersonRegistry } from "../identity";
import { PositionCounter, segmentId, textHash } from "../ids";
import { maskText } from "../mask";

export interface AdapterContext {
  sourceId: string;
  roleSet: RoleKey[];
  identityKey: string;
  contactsKey: string;
  people: PersonRegistry;
  /** Anchor for calendar expansion (ISO date). Defaults to 2026-11-11, the demo "today". */
  now?: string;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface DraftSegment {
  kind: SegmentKind;
  ts: string;
  thread: string;
  rawText: string;
  authorId: string | null;
  meta?: Record<string, unknown>;
  roleSet?: RoleKey[];
}

/** Collects segments for one source; masks every text before it becomes a Segment. */
export class ResultBuilder {
  readonly segments: Segment[] = [];
  readonly rejected: RejectedRow[] = [];
  private secrets = 0;
  private contactCount = 0;
  private contacts = new Map<string, ContactHit>();
  private personIds = new Set<string>();
  private positions = new PositionCounter();

  constructor(
    private readonly ctx: AdapterContext,
    private readonly sourceKind: SourceKind,
  ) {}

  /** Mask a string, counting what was masked. Use for every value that ends up in text or meta. */
  mask(raw: string): string {
    const r = maskText(raw, { contactsKey: this.ctx.contactsKey, people: this.ctx.people });
    this.secrets += r.secrets;
    this.contactCount += r.contacts.length;
    for (const c of r.contacts) {
      const k = `${c.token}|${c.kind}`;
      if (!this.contacts.has(k)) this.contacts.set(k, c);
    }
    return r.text;
  }

  /** Mask without counting: for meta copies of text that is also masked (and counted) in the segment text. */
  maskSilent(raw: string): string {
    return maskText(raw, { contactsKey: this.ctx.contactsKey, people: this.ctx.people }).text;
  }

  touch(personId: string | null | undefined): void {
    if (personId) this.personIds.add(personId);
  }

  add(d: DraftSegment): Segment {
    const text = this.mask(d.rawText);
    const position = this.positions.next(d.thread, d.ts);
    const seg: Segment = {
      id: segmentId(this.sourceKind, d.ts, d.thread, position, text),
      sourceId: this.ctx.sourceId,
      sourceKind: this.sourceKind,
      kind: d.kind,
      ts: d.ts,
      authorId: d.authorId,
      thread: d.thread,
      position,
      text,
      textHash: textHash(text),
      roleSet: [...(d.roleSet ?? this.ctx.roleSet)],
      version: 1,
      meta: d.meta ?? {},
    };
    this.touch(d.authorId);
    this.segments.push(seg);
    return seg;
  }

  reject(line: number, raw: string, reason: string): void {
    // rejected rows are shown in the UI: mask them too
    const r = maskText(raw.slice(0, 500), { contactsKey: this.ctx.contactsKey, people: this.ctx.people });
    this.rejected.push({ line, raw: r.text, reason });
  }

  result(): AdapterResult {
    const all = this.ctx.people.all();
    return {
      segments: this.segments,
      people: all.filter((p) => this.personIds.has(p.id)),
      rejected: this.rejected,
      maskedSecrets: this.secrets,
      maskedContacts: this.contactCount,
      contacts: [...this.contacts.values()],
    };
  }
}

export function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

export function posix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Split markdown into [{ heading, body }] chunks at ATX headings (outside code fences). */
export function splitMarkdown(md: string): { heading: string | null; text: string }[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const chunks: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  let fence = false;
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
    const h = !fence ? /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) chunks.push({ heading: h[1].trim(), lines: [line] });
    else chunks[chunks.length - 1].lines.push(line);
  }
  return chunks
    .map((c) => ({ heading: c.heading, text: c.lines.join("\n").trim() }))
    .filter((c) => c.text.length > 0);
}

/** Split YAML text into top-level key blocks (comments above a key stay with it). */
export function splitYamlTopLevel(src: string): { key: string | null; text: string }[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const chunks: { key: string | null; lines: string[] }[] = [{ key: null, lines: [] }];
  let pendingComments: string[] = [];
  for (const line of lines) {
    const m = /^([A-Za-z0-9_"'.-][^:#]*?):(\s|$)/.exec(line);
    if (m && !line.startsWith(" ") && !line.startsWith("-")) {
      chunks.push({ key: m[1].replace(/^["']|["']$/g, ""), lines: [...pendingComments, line] });
      pendingComments = [];
    } else if (/^#/.test(line) || (line.trim() === "" && pendingComments.length)) {
      pendingComments.push(line);
    } else {
      if (pendingComments.length) {
        chunks[chunks.length - 1].lines.push(...pendingComments);
        pendingComments = [];
      }
      chunks[chunks.length - 1].lines.push(line);
    }
  }
  if (pendingComments.length) chunks[chunks.length - 1].lines.push(...pendingComments);
  return chunks.map((c) => ({ key: c.key, text: c.lines.join("\n").trim() })).filter((c) => c.text.length > 0);
}

/** Split long plain text at blank lines into pieces of about `max` chars. */
export function splitPlain(src: string, max = 2000): string[] {
  const text = src.replace(/\r\n?/g, "\n").trim();
  if (text.length <= max) return text ? [text] : [];
  const paras = text.split(/\n\s*\n/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > max) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > max * 2) {
      out.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export const EPOCH_IST = "1970-01-01T05:30:00+05:30";
