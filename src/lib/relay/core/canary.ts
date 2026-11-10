// Canary leak check (Relay). Restricted segments in the demo pack carry tokens `CANARY-XXXX`; for
// every role and every surface no token outside that role's visibility may appear. Pure.
// Contract: docs/ARCHITECTURE.md section 4, "Canary tests".
import { norm } from "@/lib/text/norm";
import { renderMarkdown, type HandoverDoc } from "./compile";

export interface Surface {
  surface: string;
  text: string;
}

export interface Leak {
  surface: string;
  token: string;
}

/** Anything shaped like a canary, so a token missing from `allTokens` is still caught. */
const CANARY_SHAPE = /canary-[a-z0-9]+/gi;

/**
 * Find canary tokens in the given texts that are not in `allowedTokens`. Matching ignores case and
 * markdown markup (via norm), and also flags any CANARY-shaped token not on the allowed list.
 * A pass is an empty result.
 */
export function scanForCanaries(
  texts: readonly Surface[],
  allowedTokens: ReadonlySet<string>,
  allTokens: readonly string[],
): Leak[] {
  const allowed = new Set([...allowedTokens].map((t) => t.toUpperCase()));
  const watch = [...new Set(allTokens.map((t) => t.trim()).filter(Boolean))]
    .filter((t) => !allowed.has(t.toUpperCase()));
  const leaks: Leak[] = [];
  const seen = new Set<string>();
  const add = (surface: string, token: string) => {
    const k = `${surface}\u0000${token}`;
    if (seen.has(k)) return;
    seen.add(k);
    leaks.push({ surface, token });
  };

  for (const { surface, text } of texts) {
    const raw = (text ?? "").normalize("NFKC");
    const lower = raw.toLowerCase();
    const normed = norm(raw);
    for (const token of watch) {
      if (lower.includes(token.toLowerCase()) || normed.includes(norm(token))) add(surface, token);
    }
    for (const m of raw.matchAll(CANARY_SHAPE)) {
      const token = m[0].toUpperCase();
      if (allowed.has(token)) continue;
      // Prefer the listed spelling when the shape is a known token.
      const listed = watch.find((t) => t.toUpperCase() === token);
      add(surface, listed ?? token);
    }
  }
  return leaks;
}

export interface ExtraSurfaces {
  stubs?: string | readonly string[];
  scores?: string | readonly string[];
  timeline?: string | readonly string[];
  questions?: string | readonly string[];
  /** The export text. When omitted, the markdown export of `doc` is rendered and scanned. */
  export?: string | readonly string[];
}

/**
 * Every text surface of a compiled handover: header, each section line (`handover:<section>`), the
 * read-back form, plus the extra surfaces. The export defaults to renderMarkdown(doc), so exports are
 * always covered by the same check.
 */
export function surfacesOf(doc: HandoverDoc, extra: ExtraSurfaces = {}): Surface[] {
  const out: Surface[] = [];
  out.push({ surface: "handover:header", text: `${doc.roleLabel}\n${doc.snapshot.releaseLabel}` });
  for (const s of doc.sections) {
    out.push({ surface: `handover:${s.key}`, text: s.title });
    for (const line of s.lines) {
      out.push({ surface: `handover:${s.key}`, text: line.text });
    }
  }
  for (const item of doc.readbackForm) {
    out.push({ surface: "handover:readback_form", text: `${item.label}\n${item.hint}` });
  }
  const addExtra = (surface: string, v: string | readonly string[] | undefined) => {
    if (v === undefined) return;
    for (const text of typeof v === "string" ? [v] : v) out.push({ surface, text });
  };
  addExtra("stubs", extra.stubs);
  addExtra("scores", extra.scores);
  addExtra("timeline", extra.timeline);
  addExtra("questions", extra.questions);
  addExtra("export", extra.export ?? renderMarkdown(doc));
  return out;
}
