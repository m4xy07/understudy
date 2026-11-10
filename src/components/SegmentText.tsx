// Segment text with the cited quote highlighted. Falls back to a whitespace-tolerant match.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findQuote(text: string, quote: string | null | undefined): [number, number] | null {
  const q = (quote ?? "").trim();
  if (!q) return null;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i >= 0) return [i, i + q.length];
  const words = q.split(/\s+/).filter(Boolean).map(escapeRe);
  if (!words.length) return null;
  const m = new RegExp(words.join("[\\s*_#>\\x60-]+"), "i").exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

export function SegmentText({ text, quote }: { text: string; quote?: string | null }) {
  const span = findQuote(text, quote);
  const body = span ? (
    <>
      {text.slice(0, span[0])}
      <mark id="quote">{text.slice(span[0], span[1])}</mark>
      {text.slice(span[1])}
    </>
  ) : (
    text
  );
  return (
    <div>
      <pre className="whitespace-pre-wrap break-words font-sans text-[0.95rem] leading-relaxed text-ink">{body}</pre>
      {quote && !span && <p className="mt-2 text-sm text-warn">The quoted words were not found verbatim in this segment.</p>}
    </div>
  );
}
