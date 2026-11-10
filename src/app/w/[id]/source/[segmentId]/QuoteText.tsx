// Segment text with the cited quote marked. An accepted exact quote is highlighted as evidence;
// otherwise the closest region (locateSpan) is outlined for reviewers only and never accepted.
import { locateSpan } from "@/lib/attest/core/verify";
import { findQuote } from "@/components/SegmentText";

export function QuoteText({ text, quote, exact }: { text: string; quote: string | null; exact: boolean }) {
  let span: [number, number] | null = null;
  let mode: "exact" | "closest" | "none" = "none";
  if (quote) {
    if (exact) {
      // The verifier compares normalised text, so locate it tolerantly for display.
      const literal = findQuote(text, quote);
      const near = literal ? null : locateSpan(quote, text);
      span = literal ?? (near ? [near.start, near.end] : null);
      mode = span ? "exact" : "none";
    } else {
      const near = locateSpan(quote, text);
      if (near) {
        span = [near.start, near.end];
        mode = "closest";
      }
    }
  }
  const body = span ? (
    <>
      {text.slice(0, span[0])}
      {mode === "exact" ? (
        <mark id="quote">{text.slice(span[0], span[1])}</mark>
      ) : (
        <span
          id="quote"
          className="rounded-sm border-2 border-dashed border-warn px-0.5"
          aria-label="closest match, for reviewers only (not accepted)"
        >
          {text.slice(span[0], span[1])}
        </span>
      )}
      {text.slice(span[1])}
    </>
  ) : (
    text
  );
  return (
    <div>
      {mode === "closest" && (
        <p className="mb-3 text-sm text-warn">
          <span aria-hidden="true">≈ </span>
          The quoted words are not in this segment. The dashed region is the closest match, for reviewers only
          (not accepted).
        </p>
      )}
      <pre className="whitespace-pre-wrap break-words font-sans text-[0.95rem] leading-relaxed text-ink">{body}</pre>
      {quote && mode === "none" && (
        <p className="mt-2 text-sm text-warn">The quoted words were not found in this segment.</p>
      )}
      {quote && !exact && (
        <p className="mt-3 text-xs text-muted">
          Quote given: <q className="italic">{quote}</q>
        </p>
      )}
    </div>
  );
}
