// Reworded-fact probes (Relay). Pure. Contract: docs/ARCHITECTURE.md section 4a,
// docs/round3/specs/02_confidentiality.md section 9.
//
// A canary token only catches a leak that copies the planted text letter for letter. A claim is
// written by the model in its own words and carries no token, so a second check looks for the
// restricted facts themselves:
//   1. scanForFacts: a normalised key-term match. Deterministic, no model, runs on every render.
//   2. mergeJudge: answers of a model judge are added to the key-term findings. The judge can only
//      add findings. A judge finding counts as a leak only when its quote really is in the text.
// A role is only ever checked for the facts it may not see.
import { norm } from "@/lib/text/norm";
import type { RoleKey } from "@/lib/types";
import type { Surface } from "./canary";

export interface ProbeFact {
  id: string;
  /** Roles allowed to meet this fact. */
  roleSet: RoleKey[];
  /** Each inner list is a set of alternatives. */
  termGroups: string[][];
  /** Zero-based indexes of the groups that must be among the matches. */
  mustGroups: number[];
  minGroups: number;
  /** The fact in plain words (shown to the approver, and to the judge). */
  fact?: string;
  category?: string;
}

export interface ProbeFinding {
  factId: string;
  surface: string;
  by: "key_terms" | "judge";
  /** The words that reveal the fact: the matching window, or the judge's quote. */
  quote: string;
  /** False for a judge finding whose quote is not in the text: shown, never counted as a leak. */
  confirmed: boolean;
}

const MONTHS: Record<string, string> = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03", apr: "04", april: "04",
  may: "05", jun: "06", june: "06", jul: "07", july: "07", aug: "08", august: "08",
  sep: "09", sept: "09", september: "09", oct: "10", october: "10", nov: "11", november: "11",
  dec: "12", december: "12",
};
const MONTH_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

function stem(word: string): string {
  if (word.length < 5 || /\d/.test(word)) return word;
  // "dismiss" keeps its double s; "dismisses", "dismissed" and "dismissing" all come down to it.
  let w = word.replace(/ies$/, "y").replace(/(?:ing|ed|es|(?<!s)s)$/, "");
  if (w.length >= 5) w = w.replace(/e$/, "");
  return w.length >= 3 ? w : word;
}

function amount(digits: string, unit: string | undefined): string {
  const n = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return digits;
  const u = (unit ?? "").toLowerCase();
  const scale = u === "k" ? 1_000 : u.startsWith("lakh") || u.startsWith("lac") ? 100_000 : u.startsWith("crore") ? 10_000_000 : 1;
  return String(Math.round(n * scale));
}

/**
 * The form both the surface text and the key terms are reduced to before matching:
 * norm(); amounts to plain digits ("Rs 1,500", "1.5k" and "₹1500" are all 1500); dates to
 * "<day> <mon>" plus the ISO form when the year is known; punctuation to spaces; a light stem.
 */
export function normaliseForProbe(text: string): string {
  let s = norm(text).replace(/[‘’]/g, "'");
  // Dates first, so their digits are not read as amounts.
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y: string, mo: string, d: string) =>
    ` ${Number(d)} ${MONTH_SHORT[Number(mo) - 1] ?? mo} ${y} iso${y}${mo}${d} `);
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_RE})\\b\\.?(?:,?\\s+(\\d{4}))?`, "g");
  s = s.replace(dayMonth, (_m, d: string, mon: string, y?: string) =>
    ` ${Number(d)} ${MONTH_SHORT[Number(MONTHS[mon]) - 1]}${y ? ` ${y} iso${y}${MONTHS[mon]}${d.padStart(2, "0")}` : ""} `);
  const monthDay = new RegExp(`\\b(${MONTH_RE})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:${MONTH_RE})\\b)(?:,?\\s+(\\d{4}))?`, "g");
  s = s.replace(monthDay, (_m, mon: string, d: string, y?: string) =>
    ` ${Number(d)} ${MONTH_SHORT[Number(MONTHS[mon]) - 1]}${y ? ` ${y} iso${y}${MONTHS[mon]}${d.padStart(2, "0")}` : ""} `);
  // Amounts: currency marks dropped, separators removed, k / lakh / crore multiplied out.
  s = s.replace(/(?:₹|\brs\.?|\binr\b|\brupees?\b)\s*(\d[\d,]*(?:\.\d+)?)\s*(k|lakhs?|lacs?|crores?)?(?![a-z0-9])/g,
    (_m, n: string, unit?: string) => ` ${amount(n, unit)} `);
  s = s.replace(/\b(\d[\d,]*(?:\.\d+)?)\s*(k|lakhs?|lacs?|crores?)\b/g, (_m, n: string, unit: string) => ` ${amount(n, unit)} `);
  s = s.replace(/\b(\d{1,3}(?:,\d{2,3})+)\b/g, (_m, n: string) => n.replace(/,/g, ""));
  s = s.replace(/\b(\d+)(?:st|nd|rd|th)\b/g, "$1th");
  s = s.replace(/'s\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return s.split(" ").map(stem).join(" ");
}

const WINDOW = 400;

/** One surface string as the units a fact has to fit in: its lines, long lines in overlapping windows. */
export function probeWindows(text: string): string[] {
  const out: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.length <= WINDOW) {
      out.push(t);
      continue;
    }
    for (let i = 0; i < t.length; i += WINDOW / 2) {
      out.push(t.slice(i, i + WINDOW));
      if (i + WINDOW >= t.length) break;
    }
  }
  return out;
}

interface PreparedFact { fact: ProbeFact; groups: string[][] }

function prepare(facts: readonly ProbeFact[]): PreparedFact[] {
  return facts.map((fact) => ({ fact, groups: fact.termGroups.map((g) => g.map(normaliseForProbe).filter(Boolean)) }));
}

function matchesFact(window: string, p: PreparedFact): boolean {
  const padded = ` ${normaliseForProbe(window)} `;
  const hit = p.groups.map((g) => g.some((term) => padded.includes(` ${term} `)));
  if (hit.filter(Boolean).length < p.fact.minGroups) return false;
  return p.fact.mustGroups.every((i) => hit[i] === true);
}

/** The facts a role may not meet. */
export function hiddenFacts<T extends Pick<ProbeFact, "roleSet">>(facts: readonly T[], role: RoleKey): T[] {
  return facts.filter((f) => !f.roleSet.includes(role));
}

/**
 * Check 1. Finds restricted facts in the given texts by their key terms. Only facts whose role set
 * lacks `role` are checked. One finding per fact and surface (the first window that matches).
 */
export function scanForFacts(texts: readonly Surface[], role: RoleKey, facts: readonly ProbeFact[]): ProbeFinding[] {
  const prepared = prepare(hiddenFacts(facts, role));
  const out: ProbeFinding[] = [];
  const seen = new Set<string>();
  if (!prepared.length) return out;
  for (const { surface, text } of texts) {
    for (const window of probeWindows(text)) {
      for (const p of prepared) {
        const key = `${surface}\u0000${p.fact.id}`;
        if (seen.has(key) || !matchesFact(window, p)) continue;
        seen.add(key);
        out.push({ factId: p.fact.id, surface, by: "key_terms", quote: window, confirmed: true });
      }
    }
  }
  return out;
}

/** True when one piece of text reveals the fact by its key terms (the detector check). */
export function textRevealsFact(text: string, fact: ProbeFact): boolean {
  const [p] = prepare([fact]);
  return probeWindows(text).some((w) => matchesFact(w, p));
}

export interface JudgeAnswer {
  factId: string;
  surface: string;
  quote: string;
  /** The text the judge was shown. The quote must be found in it. */
  chunk: string;
}

/**
 * Check 2, the merge. Key-term findings are kept exactly as they are; judge answers are added.
 * There is no way for a judge answer to remove or weaken a key-term finding, and "not revealed"
 * is not an answer this function takes. A judge finding is confirmed only when its quote is in
 * the text it was shown (after norm()); an unconfirmed one is kept for the write-up.
 */
export function mergeJudge(
  keyFindings: readonly ProbeFinding[], answers: readonly JudgeAnswer[], knownFactIds: ReadonlySet<string>,
): ProbeFinding[] {
  const out: ProbeFinding[] = [...keyFindings];
  const have = new Set(keyFindings.map((f) => `${f.surface}\u0000${f.factId}`));
  for (const a of answers) {
    if (!knownFactIds.has(a.factId)) continue;
    const key = `${a.surface}\u0000${a.factId}`;
    const quote = (a.quote ?? "").trim();
    const confirmed = quote.length >= 4 && norm(a.chunk).includes(norm(quote));
    if (have.has(key)) continue;   // already a finding (key terms, or an earlier judge answer)
    if (confirmed) have.add(key);
    out.push({ factId: a.factId, surface: a.surface, by: "judge", quote, confirmed });
  }
  return out;
}

/** Findings that fail a check: every key-term finding, and judge findings with a real quote. */
export function confirmedLeaks(findings: readonly ProbeFinding[]): ProbeFinding[] {
  return findings.filter((f) => f.confirmed);
}

/** Split text into chunks of at most `max` characters at line ends, for the judge. */
export function judgeChunks(texts: readonly string[], max = 4_000): string[] {
  const out: string[] = [];
  let cur = "";
  for (const t of texts) {
    for (const line of t.split(/\r?\n/)) {
      const piece = line.trim();
      if (!piece) continue;
      for (let i = 0; i < piece.length; i += max) {
        const part = piece.slice(i, i + max);
        if (cur && cur.length + part.length + 1 > max) {
          out.push(cur);
          cur = "";
        }
        cur = cur ? `${cur}\n${part}` : part;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}
