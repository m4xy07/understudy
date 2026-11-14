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

function Cell({ c }: { c: LeakCell }) {
  if (!c.built) return <span className="text-muted">· Not built</span>;
  if (c.leaks > 0) {
    return (
      <span className="font-semibold text-bad">
        <span aria-hidden="true">✕ </span>{c.leaks} {c.leaks === 1 ? "leak" : "leaks"}
      </span>
    );
  }
  if (c.texts === 0) return <span className="text-muted">· Nothing to check</span>;
  return (
    <span className="text-ok" title={`${c.texts} ${c.texts === 1 ? "text" : "texts"} checked`}>
      <span aria-hidden="true">✓ </span>Pass
      {c.unconfirmed > 0 && <span className="ml-1 text-xs text-muted">({c.unconfirmed} unconfirmed)</span>}
    </span>
  );
}

function Block({ r, row, caption }: { r: LeakReport; row: LeakRow; caption: string }) {
  const total = row === "token" ? r.tokenCount : r.factCount;
  return (
    <div className="table-wrap mt-3">
      <table className="data-table" data-testid={`leak-${row}`}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Role</th>
            {r.surfaces.map((s) => <th key={s.key} scope="col" className="whitespace-nowrap">{s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {r.roles.map((role) => (
            <tr key={role.key}>
              <th scope="row" className="whitespace-nowrap text-left text-sm font-medium normal-case tracking-normal text-ink">
                {role.label}
                <span className="block text-xs font-normal text-muted">
                  may see {row === "token" ? role.maySee : role.maySeeFacts} of {total}
                </span>
              </th>
              {r.surfaces.map((s) => {
                const c = r.cells.find((x) => x.role === role.key && x.surface === s.key && x.row === row);
                return <td key={s.key} className="whitespace-nowrap text-sm">{c ? <Cell c={c} /> : null}</td>;
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
    ? `${r.tokenCount} canary tokens and ${r.factCount} reworded facts are planted in restricted and sensitive content.`
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

      <h3 className="mt-5 font-semibold">Exact tokens</h3>
      <p className="text-sm text-muted">Looks for the planted tokens, letter for letter.</p>
      <Block r={r} row="token" caption="Exact tokens by role and output" />

      <h3 className="mt-6 font-semibold">Reworded facts</h3>
      <p className="text-sm text-muted">
        {r.factCount === 0
          ? "No reworded facts are planted in these sources, so there is nothing to look for here."
          : r.judge.used && r.judge.at
            ? `Checked by key terms and by the model judge. Last judge run: ${when(r.judge.at)}.`
            : "Checked by key terms. The model judge has not run yet."}
      </p>
      <Block r={r} row="probe" caption="Reworded facts by role and output" />

      {!r.compiled && <p className="mt-2 text-xs text-muted">No snapshot yet: the handover columns have nothing to check.</p>}
      {r.surfaces.some((s) => !s.built) && (
        <p className="mt-2 text-xs text-muted">
          Columns marked Not built belong to parts of Understudy that have not registered their outputs yet. They are
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
