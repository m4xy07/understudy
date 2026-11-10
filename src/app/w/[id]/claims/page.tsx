import { Suspense } from "react";
import Link from "next/link";
import { claimCounters, listClaims } from "@/lib/db/queries";
import { first, loadWorkspace, type SearchParams, type WsParams } from "@/lib/page";
import { PageHead, PageLoading } from "@/components/PageHead";
import { StateChip, TRUST_LABEL, TrustChip } from "@/components/chips";
import { EmptyState } from "@/components/Notice";
import type { Attribute, Claim, ClaimState, SourceKind, Trust } from "@/lib/types";

const ATTRIBUTES: Attribute[] = ["owner", "status", "deadline", "location", "procedure", "access", "decision", "reason", "dependency", "contact", "risk"];
const TRUSTS: Trust[] = ["from_record", "corroborated", "leaver_said", "second_hand", "inferred", "ranked_options"];
const STATES: ClaimState[] = ["active", "superseded", "conflicting", "dropped"];
const KINDS: SourceKind[] = ["tasks_csv", "whatsapp", "slack", "github", "markdown", "ics", "interview"];

export default function ClaimsPage({ params, searchParams }: { params: WsParams; searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Claims params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function Select({ name, label, value, options }: { name: string; label: string; value: string; options: { v: string; l: string }[] }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select name={name} defaultValue={value} className="field">
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
    </label>
  );
}

async function Claims({ params, searchParams }: { params: WsParams; searchParams: SearchParams }) {
  const { id, roleName, role } = await loadWorkspace(params);
  const sp = await searchParams;
  const f = { attribute: first(sp.attribute), trust: first(sp.trust), state: first(sp.state), kind: first(sp.kind), view: first(sp.view) };
  const all = await listClaims(id, { role });
  const counters = claimCounters(all);
  const claims = all.filter(
    (c) =>
      (!f.attribute || c.attribute === f.attribute) &&
      (!f.trust || c.trust === f.trust) &&
      (!f.state || c.state === f.state) &&
      (!f.kind || c.sourceKinds.includes(f.kind as SourceKind)),
  );
  const verifyView = f.view === "verify";

  return (
    <>
      <PageHead module="attest" step={verifyView ? "Step 3" : "Step 2"} title={verifyView ? "Verify the claims" : "The claim ledger"}>
        Every claim cites the segment it came from. Showing what <strong>{roleName}</strong> may see.
      </PageHead>

      <section aria-label="Counters" className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card p-4">
          <p className="eyebrow">Claims by trust</p>
          <ul className="mt-2 grid gap-1 text-sm">
            {TRUSTS.filter((t) => counters.byTrust[t]).map((t) => (
              <li key={t} className="flex justify-between gap-2">
                <span>{TRUST_LABEL[t]}</span>
                <span className="mono">{counters.byTrust[t]}</span>
              </li>
            ))}
            {Object.keys(counters.byTrust).length === 0 && <li className="text-muted">None yet</li>}
          </ul>
        </div>
        <div className="card p-4">
          <p className="eyebrow">Dropped per source</p>
          <ul className="mt-2 grid gap-1 text-sm">
            {Object.entries(counters.droppedBySource).map(([k, n]) => (
              <li key={k} className="flex justify-between gap-2">
                <span>{k}</span>
                <span className="mono">{n}</span>
              </li>
            ))}
            {Object.keys(counters.droppedBySource).length === 0 && <li className="text-muted">None dropped</li>}
          </ul>
        </div>
        <div className="card p-4">
          <p className="eyebrow">Conflicts</p>
          <p className="mt-1 font-serif text-3xl">{counters.byState.conflicting ?? 0}</p>
          <p className="text-xs text-muted">Two sources disagree; a person decides.</p>
        </div>
        <div className="card p-4">
          <p className="eyebrow">Superseded</p>
          <p className="mt-1 font-serif text-3xl">{counters.byState.superseded ?? 0}</p>
          <p className="text-xs text-muted">Replaced by a newer or more authoritative source.</p>
        </div>
      </section>

      {verifyView && (
        <section className="card mb-6 p-4 text-sm text-ink-2" aria-label="Verification rules">
          <p className="font-medium text-ink">How a claim earns its label</p>
          <ul className="mt-2 grid gap-1">
            <li><strong>From record</strong>: the citation points to a segment here and the quote is found word for word.</li>
            <li><strong>Inferred</strong>: the segment exists but the quote is not in it. Never higher until a reviewer confirms.</li>
            <li><strong>Dropped</strong>: no citation points to a real segment. Counted per source, never shown as fact.</li>
          </ul>
        </section>
      )}

      <form className="card mb-4 grid gap-3 p-4 sm:grid-cols-5 sm:items-end" method="get" aria-label="Filter claims">
        {verifyView && <input type="hidden" name="view" value="verify" />}
        <Select name="attribute" label="Attribute" value={f.attribute} options={ATTRIBUTES.map((a) => ({ v: a, l: a }))} />
        <Select name="trust" label="Trust" value={f.trust} options={TRUSTS.map((t) => ({ v: t, l: TRUST_LABEL[t] }))} />
        <Select name="state" label="State" value={f.state} options={STATES.map((s) => ({ v: s, l: s }))} />
        <Select name="kind" label="Source type" value={f.kind} options={KINDS.map((k) => ({ v: k, l: k }))} />
        <div className="flex gap-2">
          <button className="btn btn-quiet" type="submit">Filter</button>
          <Link className="btn btn-quiet" href={`/w/${id}/claims${verifyView ? "?view=verify" : ""}`}>Clear</Link>
        </div>
      </form>

      <p className="mb-2 text-sm text-muted" role="status">
        {claims.length} of {all.length} claims visible to {roleName}
      </p>

      {all.length === 0 ? (
        <EmptyState title="No claims yet.">
          Go to <Link href={`/w/${id}/connect`} className="underline">Connect</Link> and press Run Understudy.
        </EmptyState>
      ) : (
        <ul className="grid gap-2">
          {claims.map((c) => (
            <ClaimRow key={c.id} c={c} ws={id} />
          ))}
        </ul>
      )}
    </>
  );
}

function ClaimRow({ c, ws }: { c: Claim; ws: string }) {
  return (
    <li className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-3xl text-[0.98rem] text-ink">{c.statement}</p>
        <span className="flex flex-wrap gap-1.5">
          <TrustChip trust={c.trust} />
          <StateChip state={c.state} note={c.stateNote} />
        </span>
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {c.entityLabel} · <span className="mono">{c.attribute}</span>
        {c.stateNote && <span className="text-ink-2"> · {c.stateNote}</span>}
      </p>
      {c.citations.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2 text-sm" aria-label="Citations">
          {c.citations.map((cit, i) => (
            <li key={`${cit.segmentId}-${i}`}>
              <Link
                href={`/w/${ws}/source/${cit.segmentId}?claim=${c.id}`}
                className="inline-flex items-center gap-1 rounded border border-rule px-2 py-0.5 text-attest underline-offset-2 hover:bg-paper-2"
              >
                <span aria-hidden="true">{cit.exact ? "¶" : "?"}</span>
                <span>Open source</span>
                <span className="mono text-xs text-muted">{cit.segmentId}</span>
                <span className="sr-only">{cit.exact ? "(exact quote)" : "(quote not exact)"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
