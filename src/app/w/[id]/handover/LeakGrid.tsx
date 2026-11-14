// The Leak check panel: every role's view of every output, checked for exact canary tokens and
// for reworded restricted facts. Used on Handover and on the Probe results page.
// The grid itself shows counts only; fact text and quotes are never rendered here.
import Link from "next/link";
import { Chip } from "@/components/chips";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { runLeakCheck, type LeakCell, type LeakReport, type LeakRow } from "@/lib/relay";
import { runProbesAction } from "../probes/actions";

export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";
}

export function LeakFallback() {
  return (
    <section className="card mt-8 p-4 sm:p-5" aria-busy="true">
      <h2 className="text-xl">Leak check</h2>
      <p className="mt-1 text-sm text-muted">Compiling every role and checking every output…</p>
    </section>
  );
}

/** A tick (or a cross) and one word. The detail is in the title and for screen readers. */
function Cell({ c }: { c: LeakCell }) {
  if (!c.built) return <span className="text-muted">· Not built</span>;
  if (c.leaks > 0) {
    return (
      <span className="font-semibold text-bad">
        <span aria-hidden="true">✕ </span>{c.leaks} {c.leaks === 1 ? "leak" : "leaks"}
      </span>
    );
  }
  if (c.texts === 0) {
    return (
      <span className="text-muted" title="Nothing to check: this output has no text for this role">
        <span aria-hidden="true">· </span>None<span className="sr-only"> to check</span>
      </span>
    );
  }
  return (
    <span className="text-ok" title={`${c.texts} ${c.texts === 1 ? "text" : "texts"} checked`}>
      <span aria-hidden="true">✓ </span>Pass
      {c.unconfirmed > 0 && <span className="ml-1 text-xs text-muted">({c.unconfirmed} unconfirmed)</span>}
    </span>
  );
}

/**
 * One block of the grid: roles across (a handful), outputs down (many). Fits a laptop screen with
 * no sideways scroll and stays readable on a phone: the table has a fixed layout and words wrap.
 */
function Block({ r, row, caption }: { r: LeakReport; row: LeakRow; caption: string }) {
  const total = row === "token" ? r.tokenCount : r.factCount;
  return (
    <div className="mt-3 w-full overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-xs sm:text-sm" data-testid={`leak-${row}`}>
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col className="w-[28%] sm:w-[24%] xl:w-[22%]" />
          {r.roles.map((role) => <col key={role.key} />)}
        </colgroup>
        <thead>
          <tr className="border-b border-rule-strong align-bottom">
            <th scope="col" className="px-1 py-2 text-left text-xs font-semibold text-muted sm:px-2">Output</th>
            {r.roles.map((role) => (
              <th key={role.key} scope="col" className="hyphens-auto break-words px-1 py-2 text-left font-medium text-ink sm:px-2 xl:text-[13px]">
                {role.label}
                <span className="block text-xs font-normal text-muted">
                  may see {row === "token" ? role.maySee : role.maySeeFacts} of {total}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.surfaces.map((s) => (
            <tr key={s.key} className="border-b border-rule align-top">
              <th scope="row" className="break-words px-1 py-1.5 text-left font-normal text-ink-2 sm:px-2">{s.label}</th>
              {r.roles.map((role) => {
                const c = r.cells.find((x) => x.role === role.key && x.surface === s.key && x.row === row);
                return <td key={role.key} className="whitespace-nowrap px-1 py-1.5 sm:px-2">{c ? <Cell c={c} /> : null}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LeakGridView({
  r, ws, isApprover, showResultsLink = true,
}: { r: LeakReport; ws: string; isApprover: boolean; showResultsLink?: boolean }) {
  const intro = r.source === "ground_truth"
    ? r.factCount > 0
      ? `${r.tokenCount} canary tokens and ${r.factCount} reworded facts are planted in restricted and sensitive content.`
      : `${r.tokenCount} canary tokens are planted in restricted and sensitive content.`
    : r.tokenCount > 0
      ? `${r.tokenCount} canary-shaped ${r.tokenCount === 1 ? "token was" : "tokens were"} found in your sources.`
      : "No canary tokens in these sources; any CANARY-shaped text would still be caught.";
  return (
    <section className="card mt-8 p-4 sm:p-5" aria-labelledby="leak-h">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h2 id="leak-h" className="text-xl">Leak check</h2>
          <p className="mt-1 text-sm text-muted">
            {intro} Every role&apos;s view of every output is checked. A role may only meet what it is allowed to see.
          </p>
        </div>
        <span data-testid="leak-summary">
          {r.allPass ? (
            <Chip symbol="✓" label={`All ${r.checks} checks pass`} tone="ok" />
          ) : (
            <Chip symbol="✕" label={`${r.failed} of ${r.checks} checks fail`} tone="bad" />
          )}
        </span>
      </div>

      {/* Side by side on a wide screen (the whole grid in one view), stacked below that. */}
      <div className={r.factCount > 0 ? "grid gap-x-8 xl:grid-cols-2" : undefined}>
        <div className="min-w-0">
          <h3 className="mt-5 font-semibold">Exact tokens</h3>
          <p className="text-sm text-muted">Looks for the planted tokens, letter for letter.</p>
          <Block r={r} row="token" caption="Exact tokens by output and role" />
        </div>
        {r.factCount > 0 && (
          <div className="min-w-0">
            <h3 className="mt-5 font-semibold">Reworded facts</h3>
            <p className="text-sm text-muted">
              {r.judge.used && r.judge.at
                ? `Checked by key terms and by the model judge. Last judge run: ${when(r.judge.at)}.`
                : "Checked by key terms. The model judge has not run yet."}
            </p>
            <Block r={r} row="probe" caption="Reworded facts by output and role" />
          </div>
        )}
      </div>
      {r.factCount === 0 && (
        <p className="mt-4 text-sm text-muted" data-testid="leak-no-probes">This setting has no reworded-fact probes yet.</p>
      )}
      <p className="mt-3 text-xs text-muted">Pass: checked, nothing leaked. None: this output has no text for that role.</p>

      {!r.compiled && <p className="mt-2 text-xs text-muted">No snapshot yet: the handover rows have nothing to check.</p>}
      {r.surfaces.some((s) => !s.built) && (
        <p className="mt-2 text-xs text-muted">
          Rows marked Not built belong to parts of Understudy that have not registered their outputs yet. They are
          not counted as passes.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {showResultsLink && <Link href={`/w/${ws}/probes`} className="text-sm text-attest underline">See probe results</Link>}
        {isApprover && r.factCount > 0 && (
          <ActionForm action={runProbesAction} hidden={{ ws }}>
            <SubmitButton className="btn-quiet btn-sm" pendingText="Running the probes…">Run probes again</SubmitButton>
          </ActionForm>
        )}
      </div>
    </section>
  );
}

/** The grid, computed live for the page (token scan and key-term probes; stored judge findings merged in). */
export async function LeakGrid({ ws, isApprover }: { ws: string; isApprover: boolean }) {
  const r = await runLeakCheck(ws);
  return <LeakGridView r={r} ws={ws} isApprover={isApprover} />;
}
