// "What changed in v{n}": the claim diff, the gaps closed and opened, and B, C and K before and
// after with one sentence each. Every string comes from whatChanged() in src/lib/relay/living,
// which reads statements under the viewing role's permissions; this component only lays it out.
import Link from "next/link";
import clsx from "clsx";
import type { ChangeView } from "@/lib/relay/living";

const MARK: Record<ChangeView["claims"][number]["kind"], { symbol: string; tone: string }> = {
  added: { symbol: "+", tone: "text-ok" },
  removed: { symbol: "−", tone: "text-bad" },
  trust: { symbol: "~", tone: "text-warn" },
  text: { symbol: "~", tone: "text-warn" },
};

export function WhatChanged({
  view: v, ws, compact = false, footer = true,
}: { view: ChangeView; ws: string; compact?: boolean; footer?: boolean }) {
  const headingId = `changed-${v.version}${compact ? "-row" : ""}`;
  return (
    <section
      aria-labelledby={headingId}
      className={clsx(compact ? "py-1" : "card mb-6 overflow-hidden")}
    >
      <div className={clsx(!compact && "border-l-4 border-relay p-4 sm:p-5")}>
        {compact ? (
          <p id={headingId} className="font-medium">{v.heading}</p>
        ) : (
          <h2 id={headingId} className="font-serif text-xl">{v.heading}</h2>
        )}
        <p className="mt-0.5 text-sm text-muted">{v.sub}</p>
        <p className="mt-2 text-sm">{v.causeLine}</p>

        {(v.claims.length > 0 || v.gaps.length > 0 || v.plan) && (
          <ul className="mt-3 grid gap-1.5 text-sm" aria-label={`Changes in v${v.version}`}>
            {v.claims.map((c) => (
              <li key={`${c.kind}-${c.claimId}`} className="flex gap-2">
                <span aria-hidden="true" className={clsx("mono w-3 flex-none font-semibold", MARK[c.kind].tone)}>{MARK[c.kind].symbol}</span>
                <span className="text-ink">{c.text}</span>
              </li>
            ))}
            {v.gaps.map((g) => (
              <li key={g} className="flex gap-2">
                <span aria-hidden="true" className={clsx("mono w-3 flex-none font-semibold", g.startsWith("Gap closed") ? "text-ok" : "text-bad")}>
                  {g.startsWith("Gap closed") ? "✓" : "!"}
                </span>
                <span className="text-ink">{g}</span>
              </li>
            ))}
            {v.plan && (
              <li className="flex gap-2">
                <span aria-hidden="true" className="mono w-3 flex-none font-semibold text-warn">~</span>
                <span className="text-ink-2">{v.plan}</span>
              </li>
            )}
          </ul>
        )}
        {v.empty && <p className="mt-3 text-sm text-muted">{v.empty}</p>}
        {v.stub && (
          <p className="mt-2 text-sm text-muted">
            <span aria-hidden="true">⊘ </span>
            {v.stub}
          </p>
        )}

        <ul className="mt-3 grid gap-1 border-t border-rule pt-3 text-sm text-ink-2" aria-label={`Scores in v${v.version}`}>
          {v.scores.map((s) => <li key={s}>{s}</li>)}
        </ul>

        {v.reack && !compact && (
          <p className="mt-3 text-sm text-warn">
            <span aria-hidden="true">! </span>
            {v.reack}
          </p>
        )}
        {footer && !compact && (
          <p className="mt-3 text-sm">
            <Link className="underline" href={`/w/${ws}/review#snap-h`}>See all versions</Link>
          </p>
        )}
      </div>
    </section>
  );
}
