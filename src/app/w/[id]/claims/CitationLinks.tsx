import Link from "next/link";
import { Chip } from "@/components/chips";
import type { Claim } from "@/lib/types";

/** A claim's citations as links to the source page, where the quote is highlighted. */
export function CitationLinks({ claim, ws }: { claim: Pick<Claim, "id" | "citations">; ws: string }) {
  if (claim.citations.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2 text-sm" aria-label="Citations">
      {claim.citations.map((cit, i) => (
        <li key={`${cit.segmentId}-${i}`} className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Link
            href={`/w/${ws}/source/${cit.segmentId}?claim=${claim.id}&cite=${i}`}
            className="inline-flex items-center gap-1 rounded border border-rule px-2 py-0.5 text-attest underline-offset-2 hover:bg-paper-2"
          >
            <span aria-hidden="true">{cit.accepted ? (cit.exact ? "¶" : "≈") : "✕"}</span>
            <span>Open source</span>
            <span className="mono text-xs text-muted">{cit.segmentId}</span>
            <span className="sr-only">
              {!cit.accepted ? "(citation not accepted)" : cit.exact ? "(exact quote)" : "(quote not exact)"}
            </span>
          </Link>
          {!cit.accepted ? (
            <Chip symbol="✕" label="citation not accepted" tone="bad" />
          ) : !cit.exact ? (
            <Chip symbol="≈" label="quote not exact" tone="warn" />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
