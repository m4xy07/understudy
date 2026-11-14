import { Suspense } from "react";
import Link from "next/link";
import { listClaims } from "@/lib/db/queries";
import { first, loadWorkspace, type SearchParams, type WsParams } from "@/lib/page";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Chip, StateChip, TierChip, TRUST_LABEL, TrustChip } from "@/components/chips";
import { EmptyState, Notice } from "@/components/Notice";
import type { Attribute, Claim, ClaimState, Importance, SourceKind, Trust } from "@/lib/types";
import { TRUST_ORDER } from "@/lib/trust";
import { extractionNote, listDropped, type DroppedItem } from "./data";
import { CitationLinks } from "./CitationLinks";

const ATTRIBUTES: Attribute[] = ["owner", "status", "deadline", "location", "procedure", "access", "decision", "reason", "dependency", "contact", "risk"];
const TRUSTS: readonly Trust[] = TRUST_ORDER;
const STATES: ClaimState[] = ["active", "superseded", "conflicting", "dropped"];
const KINDS: SourceKind[] = ["tasks_csv", "whatsapp", "slack", "github", "markdown", "ics", "interview", "finding"];
const IMPORTANCE: Importance[] = ["blocking", "important", "normal"];
// Counters shown above the list. "Successor found" appears only once a finding exists (see below).
const COUNTED: Trust[] = ["from_record", "corroborated", "inferred", "leaver_said", "successor_found"];

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

function Stat({ label, n, hint }: { label: string; n: number; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 font-serif text-3xl">{n}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

async function Claims({ params, searchParams }: { params: WsParams; searchParams: SearchParams }) {
  const { id, roleName, role } = await loadWorkspace(params);
  const sp = await searchParams;
  const f = {
    attribute: first(sp.attribute), trust: first(sp.trust), state: first(sp.state), kind: first(sp.kind),
    importance: first(sp.importance), view: first(sp.view),
  };
  const [all, dropped, ext] = await Promise.all([listClaims(id, { role }), listDropped(id, role), extractionNote(id)]);
  const live = all.filter((c) => c.state !== "dropped");
  const retired = all.length - live.length;
  const byId = new Map(all.map((c) => [c.id, c]));
  const trustCount = (t: Trust) => live.filter((c) => c.trust === t).length;
  const superseded = all.filter((c) => c.state === "superseded");
  const conflicting = all.filter((c) => c.state === "conflicting");
  const claims = all.filter(
    (c) =>
      (!f.attribute || c.attribute === f.attribute) &&
      (!f.trust || c.trust === f.trust) &&
      (!f.state || c.state === f.state) &&
      (!f.importance || c.importance === f.importance) &&
      (!f.kind || c.sourceKinds.includes(f.kind as SourceKind)),
  );
  const verifyView = f.view === "verify";
  const droppedBySource = new Map<string, DroppedItem[]>();
  for (const d of dropped) droppedBySource.set(d.sourceName, [...(droppedBySource.get(d.sourceName) ?? []), d]);
  const supNotes = new Map<string, number>();
  for (const c of superseded) {
    const rule = (c.stateNote ?? "Superseded").replace(/ \(updated on [^)]*\)| on \d{4}-\d{2}-\d{2}$/g, "");
    supNotes.set(rule, (supNotes.get(rule) ?? 0) + 1);
  }
  const modelTrouble = ext?.note && (/unavailable|failed|not read/i.test(ext.note) || ext.failed > 0);

  return (
    <>
      <PageHead
        module="attest"
        step={verifyView ? "Step 3" : "Step 2"}
        title={verifyView ? "Verify the claims" : "The claim ledger"}
        aside={
          <Link href={`/w/${id}/evaluation`} className="btn btn-quiet btn-sm">
            Evaluation <span aria-hidden="true">→</span>
          </Link>
        }
      >
        Every claim cites the segment it came from. Showing what <strong>{roleName}</strong> may see.
      </PageHead>

      {modelTrouble && (
        <div className="mb-4">
          <Notice tone="warn" title="Some sources were not read by the model.">
            {ext?.note}
          </Notice>
        </div>
      )}

      <section aria-label="Claims by trust" className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {COUNTED.filter((t) => t !== "successor_found" || trustCount(t) > 0).map((t) => (
          <div key={t} className="card p-4">
            <p className="eyebrow">{TRUST_LABEL[t]}</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="font-serif text-3xl">{trustCount(t)}</span>
              <TrustChip trust={t} />
            </p>
          </div>
        ))}
      </section>

      <section aria-label="Rule outcomes" className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Conflicting" n={conflicting.length} hint="Two sources disagree and no rule settles it. A person decides." />
        <div className="card p-4">
          <p className="eyebrow">Superseded</p>
          <p className="mt-1 font-serif text-3xl">{superseded.length}</p>
          {supNotes.size > 0 ? (
            <ul className="mt-1 grid gap-0.5 text-xs text-ink-2">
              {[...supNotes.entries()].map(([note, n]) => (
                <li key={note}>
                  {n} × {note.replace(/^Superseded: /, "")}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">Replaced by a newer or more authoritative source.</p>
          )}
        </div>
        <div className="card p-4">
          <p className="eyebrow">Drafts dropped per source</p>
          <p className="mt-1 font-serif text-3xl">{dropped.length}</p>
          {retired > 0 && (
            <p className="text-xs text-muted">
              Not counted here: {retired} claim{retired === 1 ? "" : "s"} retired by a later run (state Dropped in the list).
            </p>
          )}
          {droppedBySource.size === 0 ? (
            <p className="text-xs text-muted">No draft lost its citation.</p>
          ) : (
            <ul className="mt-1 grid gap-1 text-sm">
              {[...droppedBySource.entries()].map(([name, items]) => (
                <li key={name}>
                  <details>
                    <summary className="cursor-pointer">
                      {name}: <span className="mono">{items.length}</span>
                    </summary>
                    <ul className="mt-1 grid gap-1 border-l border-rule pl-3 text-xs text-ink-2">
                      {items.map((d) => (
                        <li key={d.id}>
                          <span className="text-ink">{d.statement}</span>
                          <br />
                          <span className="text-bad">Dropped: {d.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {verifyView && (
        <section className="card mb-6 p-4 text-sm text-ink-2" aria-label="Verification rules">
          <p className="font-medium text-ink">How a claim earns its label</p>
          <ul className="mt-2 grid gap-1">
            <li><strong>From record</strong>: the citation points to a segment the model was shown and the quote is found word for word.</li>
            <li><strong>Corroborated</strong>: two independent sources agree and at least one is a record.</li>
            <li><strong>Inferred</strong>: the segment exists but the quote is not in it, or the support check said no. Never higher until a reviewer confirms.</li>
            <li><strong>Dropped</strong>: no citation points to a segment the model was shown. Counted per source, never shown as fact.</li>
            <li><strong>Superseded / Conflicting</strong>: the source with more authority for that attribute wins; the same person or a reply updates; otherwise a person decides.</li>
          </ul>
        </section>
      )}

      <form className="card mb-4 grid gap-3 p-4 sm:grid-cols-6 sm:items-end" method="get" aria-label="Filter claims">
        {verifyView && <input type="hidden" name="view" value="verify" />}
        <Select name="attribute" label="Attribute" value={f.attribute} options={ATTRIBUTES.map((a) => ({ v: a, l: a }))} />
        <Select name="trust" label="Trust" value={f.trust} options={TRUSTS.map((t) => ({ v: t, l: TRUST_LABEL[t] }))} />
        <Select name="state" label="State" value={f.state} options={STATES.map((s) => ({ v: s, l: s }))} />
        <Select name="importance" label="Importance" value={f.importance} options={IMPORTANCE.map((s) => ({ v: s, l: s }))} />
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
            <ClaimRow key={c.id} c={c} ws={id} winner={c.supersededBy ? byId.get(c.supersededBy) ?? null : null} />
          ))}
        </ul>
      )}
    </>
  );
}

const IMPORTANCE_STYLE: Record<Importance, { symbol: string; label: string; tone: "bad" | "warn" | "plain" }> = {
  blocking: { symbol: "■", label: "Blocking", tone: "bad" },
  important: { symbol: "▲", label: "Important", tone: "warn" },
  normal: { symbol: "·", label: "Normal", tone: "plain" },
};

function ClaimRow({ c, ws, winner }: { c: Claim; ws: string; winner: Claim | null }) {
  const imp = IMPORTANCE_STYLE[c.importance];
  return (
    <li className="card min-w-0 scroll-mt-24 p-4" id={c.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-3xl text-[0.98rem] text-ink">{c.statement}</p>
        <span className="flex flex-wrap gap-1.5">
          <TrustChip trust={c.trust} />
          <StateChip state={c.state} note={c.stateNote} />
          <Chip symbol={imp.symbol} label={imp.label} tone={imp.tone} title="Importance from the checklist weight" />
          <TierChip tier={c.tier} />
        </span>
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {c.entityLabel} · <span className="mono">{c.attribute}</span> · <span className="mono">{c.value}</span>
        {c.supportCheck && <span> · support check: {c.supportCheck}</span>}
        {c.review !== "pending" && <span> · review: {c.review}</span>}
      </p>
      {c.stateNote && <p className="mt-1 text-xs text-ink-2">{c.stateNote}</p>}
      {c.state === "superseded" && winner && (
        <p className="mt-1 text-xs">
          Superseded by{" "}
          <a href={`#${winner.id}`} className="text-attest underline">
            {winner.statement}
          </a>
        </p>
      )}
      <CitationLinks claim={c} ws={ws} />
      <p className="mt-2 text-sm">
        <Link href={`/w/${ws}/claims/${c.id}`} className="text-attest underline underline-offset-2">
          History<span className="sr-only"> of this claim</span>
        </Link>
      </p>
    </li>
  );
}
