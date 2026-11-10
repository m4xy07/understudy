import { Suspense } from "react";
import Link from "next/link";
import clsx from "clsx";
import { roleLabel } from "@/lib/pack";
import { first, loadWorkspace, type SearchParams, type WsParams } from "@/lib/page";
import { getReleaseInfo, listReviewClaims, listSnapshotHistory, loadEvidence, type GapView } from "@/lib/relay";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Chip, CoverageChip, StateChip, TierChip, TrustChip } from "@/components/chips";
import { ScoreLine } from "@/components/Scores";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { EmptyState, Notice } from "@/components/Notice";
import type { Claim, ReviewTier, RoleKey } from "@/lib/types";
import { approveSnapshotAction, bulkApproveAction, reviewClaimAction, savePlanAction } from "./actions";
import { TierCReview, type EvidenceItem } from "./TierCReview";

export default function ReviewPage({ params, searchParams }: { params: WsParams; searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Review params={params} searchParams={searchParams} />
    </Suspense>
  );
}

type Show = "pending" | "decided" | "all";
const TIERS: ReviewTier[] = ["A", "B", "C"];

const TIER_INFO: Record<ReviewTier, { title: string; blurb: string }> = {
  A: { title: "Tier A · bulk approve", blurb: "Corroborated, normal importance, nothing flagged." },
  B: { title: "Tier B · one by one", blurb: "Approve, edit or reject each claim. An edit keeps its citations and is labelled “edited by reviewer”." },
  C: { title: "Tier C · evidence and a reason", blurb: "Sensitive, conflicting or blocking. Open the evidence, then write why it is right or wrong." },
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";
}

async function Review({ params, searchParams }: { params: WsParams; searchParams: SearchParams }) {
  const { id, role, pack, roleName } = await loadWorkspace(params);
  const sp = await searchParams;
  const tierParam = first(sp.tier).toUpperCase();
  const tierFilter = (TIERS as string[]).includes(tierParam) ? (tierParam as ReviewTier) : null;
  const showParam = first(sp.show);
  const show: Show = showParam === "decided" || showParam === "all" ? showParam : "pending";

  const approverName = roleLabel(pack.approverRole as RoleKey, pack);
  const isApprover = role === pack.approverRole;
  const isLeaver = role === pack.leaverRole;

  const [claims, release, history] = await Promise.all([
    listReviewClaims(id, role),
    getReleaseInfo(id),
    listSnapshotHistory(id),
  ]);
  const reviewable = claims.filter((c) => c.state !== "dropped" && c.state !== "superseded");
  const pending = reviewable.filter((c) => c.review === "pending");
  const pendingBy = (t: ReviewTier) => pending.filter((c) => c.tier === t).length;
  const decided = reviewable.filter((c) => c.review !== "pending");
  const count = (r: Claim["review"]) => reviewable.filter((c) => c.review === r).length;
  const notReviewable = claims.length - reviewable.length;

  const shown = reviewable.filter((c) =>
    (show === "all" || (show === "pending" ? c.review === "pending" : c.review !== "pending")) &&
    (!tierFilter || c.tier === tierFilter));

  // Evidence for the tier C claims shown with actions, read as the viewing role (RLS).
  const tierCOpen = isApprover ? shown.filter((c) => c.tier === "C" && c.review === "pending") : [];
  const evidence = await loadEvidence(id, role, tierCOpen.flatMap((c) => c.citations.filter((x) => x.accepted).map((x) => x.segmentId)));

  const href = (t: ReviewTier | null, s: Show) => {
    const q = new URLSearchParams();
    if (t) q.set("tier", t);
    if (s !== "pending") q.set("show", s);
    const qs = q.toString();
    return `/w/${id}/review${qs ? `?${qs}` : ""}#claims`;
  };
  const latest = history[0] ?? null;
  const canApproveNow = isApprover && release.blockers.length === 0;

  return (
    <>
      <PageHead module="relay" step="Step 6" title="Review and approve">
        The approver ({approverName}) checks each claim, plans every open blocking gap, then approves a hashed snapshot.
        Nothing reaches a handover without that approval.
      </PageHead>

      {isLeaver ? (
        <div className="mb-6">
          <Notice tone="warn" title="The leaver can never approve.">
            You are viewing as {roleName}. Review and approval belong to {approverName}; this page is read only for you.
            Your part is answering the gap questions on <Link className="underline" href={`/w/${id}/ask`}>Ask</Link>.
          </Notice>
        </div>
      ) : !isApprover ? (
        <div className="mb-6">
          <Notice tone="info" title={`Viewing as ${roleName}: read only.`}>
            Only {approverName} can review claims and approve the snapshot. Switch &ldquo;Viewing as&rdquo; in the header to act.
          </Notice>
        </div>
      ) : null}

      {/* Release state */}
      <section className="card mb-6 overflow-hidden" aria-labelledby="release-h">
        <div className="flex flex-wrap items-start justify-between gap-4 border-l-4 border-relay p-4 sm:p-5">
          <div>
            <p id="release-h" className="eyebrow text-relay">Release state if approved now</p>
            <p className="mt-1 font-serif text-2xl">{release.line}</p>
            <p className="mt-2">
              <ScoreLine scores={release.scores} provisional={!latest} />
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {release.blockers.length === 0 ? (
              <Chip symbol="✓" label="Release rule met" tone="ok" />
            ) : (
              <Chip symbol="!" label={`${release.blockers.length} thing${release.blockers.length === 1 ? "" : "s"} to do`} tone="warn" />
            )}
            {latest && (
              <span className="text-xs text-muted">
                Latest: v{latest.snapshot.version} · <span className="mono">{latest.snapshot.hash.slice(0, 12)}</span>
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Counts */}
      <section className="mb-6 grid gap-3 sm:grid-cols-4" aria-label="Review counts">
        {TIERS.map((t) => (
          <Link key={t} href={href(t, "pending")} className="card block p-4 no-underline hover:border-rule-strong">
            <p className="eyebrow">Tier {t} pending</p>
            <p className="mt-1 font-serif text-3xl text-ink">{pendingBy(t)}</p>
            <p className="text-xs text-muted">{TIER_INFO[t].blurb.split(".")[0]}.</p>
          </Link>
        ))}
        <div className="card p-4">
          <p className="eyebrow">Decided</p>
          <p className="mt-1 font-serif text-3xl">{decided.length}</p>
          <p className="text-xs text-muted">
            {count("approved")} approved · {count("edited")} edited · {count("rejected")} rejected
            {notReviewable > 0 && ` · ${notReviewable} superseded or dropped`}
          </p>
        </div>
      </section>

      {/* Where to start: the bulk approve sits at the bottom of a long list, so offer it here too. */}
      {isApprover && (
        <section aria-label="Where to start" className="card mb-6 flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="max-w-2xl text-sm text-ink-2">
            <span className="font-medium text-ink">Where to start:</span>{" "}
            {pendingBy("A") > 0
              ? "approve the low-risk tier A claims in one go, decide tier B and C below, then "
              : "decide tier B and C claims below, then "}
            fill the <a href="#plan-h" className="text-attest underline">continuation plan</a> and{" "}
            <a href="#snap-h" className="text-attest underline">approve the snapshot</a>.
          </p>
          {pendingBy("A") > 0 && (
            <ActionForm action={bulkApproveAction} hidden={{ ws: id }} className="flex flex-col items-end">
              <SubmitButton pendingText="Approving…">Approve {pendingBy("A")} tier A claim{pendingBy("A") === 1 ? "" : "s"}</SubmitButton>
            </ActionForm>
          )}
        </section>
      )}

      {/* Claims */}
      <section id="claims" aria-labelledby="claims-h" className="scroll-mt-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h2 id="claims-h" className="text-xl">Claims</h2>
          <nav aria-label="Filter claims" className="flex flex-wrap gap-4 text-sm">
            <span className="flex flex-wrap items-center gap-1">
              <span className="text-muted">Tier</span>
              {([null, ...TIERS] as (ReviewTier | null)[]).map((t) => (
                <FilterLink key={t ?? "all"} href={href(t, show)} active={tierFilter === t}>{t ?? "All"}</FilterLink>
              ))}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <span className="text-muted">Show</span>
              {(["pending", "decided", "all"] as Show[]).map((s) => (
                <FilterLink key={s} href={href(tierFilter, s)} active={show === s}>{s[0].toUpperCase() + s.slice(1)}</FilterLink>
              ))}
            </span>
          </nav>
        </div>

        {reviewable.length === 0 ? (
          <EmptyState title="Nothing to review yet.">
            Run Understudy from <Link className="underline" href={`/w/${id}/connect`}>Connect</Link> first.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title={show === "pending" ? "No pending claims here." : "No claims match this filter."}>
            {show === "pending" && pending.length === 0 ? "Every claim has been decided. Plan the open gaps, then approve the snapshot below." : null}
          </EmptyState>
        ) : (
          <div className="grid gap-6">
            {(["C", "B", "A"] as ReviewTier[]).map((t) => {
              const list = shown.filter((c) => c.tier === t);
              if (!list.length) return null;
              const pendingA = list.filter((c) => c.review === "pending").length;
              return (
                <section key={t} aria-labelledby={`tier-${t}`}>
                  <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h3 id={`tier-${t}`} className="text-lg">
                        {TIER_INFO[t].title} <span className="text-sm text-muted">({list.length})</span>
                      </h3>
                      <p className="text-sm text-muted">{TIER_INFO[t].blurb}</p>
                    </div>
                    {t === "A" && isApprover && pendingA > 0 && (
                      <ActionForm action={bulkApproveAction} hidden={{ ws: id }} className="flex flex-col items-end">
                        <SubmitButton pendingText="Approving…">Approve {pendingBy("A")} tier A claim{pendingBy("A") === 1 ? "" : "s"}</SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                  <ul className="grid gap-2">
                    {list.map((c) => (
                      <ClaimCard
                        key={c.id}
                        claim={c}
                        ws={id}
                        isApprover={isApprover}
                        evidence={c.tier === "C" && c.review === "pending" && isApprover
                          ? c.citations.filter((x) => x.accepted).map((x) => {
                            const seg = evidence[x.segmentId];
                            return {
                              segmentId: x.segmentId,
                              quote: x.quote,
                              text: seg?.text ?? null,
                              sourceName: seg?.sourceName ?? "Source",
                              when: seg ? when(seg.ts) : "",
                              href: `/w/${id}/source/${x.segmentId}?claim=${c.id}`,
                            } satisfies EvidenceItem;
                          })
                          : null}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </section>

      {/* Continuation plan */}
      <section className="mt-10" aria-labelledby="plan-h">
        <h2 id="plan-h" className="text-xl">Continuation plan</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          B &gt; 0 can be released only when every open blocking gap has an owner, a due date and the approver&apos;s risk note.
          These go into the snapshot and appear as open items in every handover.
        </p>
        {release.gaps.length === 0 ? (
          <p className="mt-3 text-sm text-ok">
            <span aria-hidden="true">✓ </span>No open blocking gaps.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {release.gaps.map((g) => <PlanCard key={`${g.responsibilityId}|${g.checkKey}`} gap={g} ws={id} isApprover={isApprover} />)}
          </ul>
        )}
      </section>

      {/* Approve snapshot */}
      <section className="card mt-10 p-4 sm:p-5" aria-labelledby="snap-h">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <h2 id="snap-h" className="text-xl">Approve snapshot</h2>
            <p className="mt-1 text-sm text-muted">
              Hashes the approved claims with their evidence segment versions, the continuation plan and the scores (SHA-256 of
              canonical JSON). Each approval is a new version; earlier versions stay.
            </p>
          </div>
          {isApprover && (
            <ActionForm action={approveSnapshotAction} hidden={{ ws: id }} className="flex flex-col items-end">
              <SubmitButton pendingText="Hashing…" disabled={!canApproveNow}>
                Approve snapshot v{(latest?.snapshot.version ?? 0) + 1}
              </SubmitButton>
            </ActionForm>
          )}
        </div>
        <div className="mt-3">
          {!isApprover ? (
            <p className="text-sm">
              {isLeaver ? "The leaver can never approve." : `Only ${approverName} can approve the snapshot.`}
            </p>
          ) : release.blockers.length > 0 ? (
            <div role="status" className="rounded-md border border-warn/40 bg-[#f6eedb] px-4 py-3 text-sm text-[#5c3f0a]">
              <p className="font-semibold">Approval is blocked:</p>
              <ul className="mt-1 list-disc pl-5">
                {release.blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-ok">
              <span aria-hidden="true">✓ </span>Ready. It will be released as &ldquo;{release.line}&rdquo;.
            </p>
          )}
        </div>

        <h3 className="mt-6 text-lg">Version history</h3>
        {history.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No snapshot approved yet.</p>
        ) : (
          <div className="table-wrap mt-2">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">SHA-256</th>
                  <th scope="col">Approved</th>
                  <th scope="col">Release</th>
                  <th scope="col">Claims</th>
                  <th scope="col">Since previous</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.snapshot.id}>
                    <td className="mono">v{h.snapshot.version}</td>
                    <td>
                      <span className="mono" title={h.snapshot.hash}>{h.snapshot.hash.slice(0, 12)}</span>{" "}
                      {h.verified ? (
                        <span className="text-xs text-ok"><span aria-hidden="true">✓ </span>verified</span>
                      ) : (
                        <span className="text-xs text-bad"><span aria-hidden="true">✕ </span>does not verify</span>
                      )}
                    </td>
                    <td className="text-sm">{when(h.snapshot.approvedAt)}</td>
                    <td className="text-sm">{h.label}</td>
                    <td className="mono">{h.claimCount}</td>
                    <td className="text-sm">
                      {h.diff ? (
                        h.diff.fromVersion === null ? (
                          <span className="text-muted">First version</span>
                        ) : (
                          <span>
                            <span className="text-ok">+{h.diff.added.length}</span> added ·{" "}
                            <span className="text-bad">−{h.diff.removed.length}</span> removed ·{" "}
                            <span className="text-warn">~{h.diff.changed.length}</span> changed
                            {h.diff.planChanged && " · plan changed"}
                          </span>
                        )
                      ) : (
                        <span className="text-muted">n/a</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {latest && (
          <p className="mt-3 text-sm">
            <Link className="underline" href={`/w/${id}/handover`}>Open the handover</Link>{" "}
            <span className="text-muted">— switch &ldquo;Viewing as&rdquo; to see what each role receives.</span>
          </p>
        )}
      </section>
    </>
  );
}

function FilterLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={clsx(
        "rounded-full border px-2.5 py-0.5 no-underline",
        active ? "border-relay bg-relay text-card" : "border-rule text-ink-2 hover:border-rule-strong",
      )}
    >
      {children}
    </Link>
  );
}

const REVIEW_CHIP: Record<Claim["review"], { symbol: string; label: string; tone: "ok" | "warn" | "bad" | "plain" }> = {
  pending: { symbol: "○", label: "Pending", tone: "plain" },
  approved: { symbol: "✓", label: "Approved", tone: "ok" },
  edited: { symbol: "✎", label: "Edited by reviewer", tone: "ok" },
  rejected: { symbol: "✕", label: "Rejected", tone: "bad" },
};

function ClaimCard({
  claim: c, ws, isApprover, evidence,
}: { claim: Claim; ws: string; isApprover: boolean; evidence: EvidenceItem[] | null }) {
  const firstCite = c.citations.find((x) => x.accepted) ?? c.citations[0];
  const r = REVIEW_CHIP[c.review];
  return (
    <li className={clsx("card p-3 sm:p-4", c.tier === "C" && c.review === "pending" && "border-l-4 border-l-warn")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-3xl text-ink">{c.statement}</p>
        <span className="flex flex-wrap gap-1.5">
          <TierChip tier={c.tier} />
          <TrustChip trust={c.trust} />
          {c.state !== "active" && <StateChip state={c.state} note={c.stateNote} />}
          {c.review !== "pending" && <Chip symbol={r.symbol} label={r.label} tone={r.tone} />}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {c.entityLabel} · {c.attribute}
        {c.importance !== "normal" && ` · ${c.importance}`}
        {c.stateNote && ` · ${c.stateNote}`}
        {firstCite && c.tier !== "C" && (
          <>
            {" · "}
            <Link href={`/w/${ws}/source/${firstCite.segmentId}?claim=${c.id}`} className="text-attest underline">
              Open evidence
            </Link>
          </>
        )}
        {c.reviewNote && <> · Reason: &ldquo;{c.reviewNote}&rdquo;</>}
      </p>

      {isApprover && c.review === "pending" && c.tier === "C" && evidence && (
        <TierCReview ws={ws} claimId={c.id} evidence={evidence} />
      )}

      {isApprover && c.review === "pending" && c.tier !== "C" && (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          <ActionForm action={reviewClaimAction} hidden={{ ws, claimId: c.id }} className="flex flex-wrap gap-2">
            <SubmitButton name="decision" value="approved" className="btn-sm" pendingText="Saving…">Approve</SubmitButton>
            <SubmitButton name="decision" value="rejected" className="btn-quiet btn-sm" pendingText="Saving…">Reject</SubmitButton>
          </ActionForm>
          {c.tier === "B" && (
            <details className="min-w-0 flex-1 basis-72">
              <summary className="btn btn-quiet btn-sm inline-flex cursor-pointer list-none">Edit</summary>
              <ActionForm action={reviewClaimAction} hidden={{ ws, claimId: c.id }} className="mt-2 grid gap-2">
                <label className="grid gap-1 text-sm">
                  <span>Statement shown to people</span>
                  <textarea name="statement" rows={2} className="field" defaultValue={c.statement} required />
                </label>
                <label className="grid gap-1 text-sm">
                  <span>Note <span className="text-muted">(optional)</span></span>
                  <input name="note" className="field" />
                </label>
                <p className="text-xs text-muted">Citations and trust stay as they are; the line is labelled &ldquo;edited by reviewer&rdquo;.</p>
                <div>
                  <SubmitButton name="decision" value="edited" className="btn-sm" pendingText="Saving…">Save edit</SubmitButton>
                </div>
              </ActionForm>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

const MISSING: Record<string, string> = { owner: "owner", dueDate: "due date", riskNote: "risk note" };

function PlanCard({ gap: g, ws, isApprover }: { gap: GapView; ws: string; isApprover: boolean }) {
  const p = g.plan;
  const missing = !p ? ["owner", "dueDate", "riskNote"] : (["owner", "dueDate", "riskNote"] as const).filter((k) => !String(p[k] ?? "").trim());
  const complete = missing.length === 0;
  return (
    <li className={clsx("card p-4", !complete && "border-l-4 border-l-warn")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          {g.responsibilityTitle}: {g.checkLabel}
        </p>
        <span className="flex gap-1.5">
          <CoverageChip coverage={(["covered", "partial", "missing", "restricted", "conflicting"].includes(g.coverage) ? g.coverage : "missing") as "missing"} />
          {complete ? <Chip symbol="✓" label="Planned" tone="ok" /> : <Chip symbol="!" label={`Needs ${missing.map((m) => MISSING[m]).join(", ")}`} tone="warn" />}
        </span>
      </div>
      {isApprover ? (
        <ActionForm
          action={savePlanAction}
          hidden={{ ws, responsibilityId: g.responsibilityId, checkKey: g.checkKey }}
          className="mt-3 grid gap-2 sm:grid-cols-[1fr_10rem_2fr_auto] sm:items-end"
        >
          <label className="grid gap-1 text-sm">
            <span>Owner</span>
            <input name="owner" className="field" defaultValue={p?.owner ?? ""} required placeholder="Who closes it" />
          </label>
          <label className="grid gap-1 text-sm">
            <span>Due date</span>
            <input name="dueDate" type="date" className="field" defaultValue={p?.dueDate ?? ""} required />
          </label>
          <label className="grid gap-1 text-sm">
            <span>Risk note</span>
            <input name="riskNote" className="field" defaultValue={p?.riskNote ?? ""} required placeholder="What could go wrong meanwhile" />
          </label>
          <SubmitButton className="btn-quiet" pendingText="Saving…">Save</SubmitButton>
        </ActionForm>
      ) : p ? (
        <p className="mt-2 text-sm text-muted">
          {p.owner || "No owner"} · due {p.dueDate || "not set"} · {p.riskNote || "no risk note"}
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">Not planned yet.</p>
      )}
    </li>
  );
}
