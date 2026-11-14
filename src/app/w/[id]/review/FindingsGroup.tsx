// Review group "Successor findings": what the successor recorded after the handover, each one a
// person's word until a record backs it. The approver opens the evidence, writes a reason and
// approves (re-test, next snapshot) or rejects. Only findings the viewing role may see are passed in.
import clsx from "clsx";
import { Chip, TierChip, TrustChip } from "@/components/chips";
import type { FindingView } from "@/lib/relay/living";
import { FindingReview } from "./FindingReview";

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";
}

export function FindingsGroup({
  ws, findings, isApprover, isLeaver, approverLabel, successorLabel, nextVersion,
}: {
  ws: string;
  findings: FindingView[];
  isApprover: boolean;
  isLeaver: boolean;
  approverLabel: string;
  successorLabel: string;
  nextVersion: number;
}) {
  const shown = findings.filter((f) => f.status !== "withdrawn");
  if (shown.length === 0) return null;
  const pending = shown.filter((f) => f.status === "pending").length;
  return (
    <section id="findings" aria-labelledby="findings-h" className="mb-8 scroll-mt-4">
      <h2 id="findings-h" className="text-xl">Successor findings ({pending})</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Found by {successorLabel} after the handover. Each one is a person&apos;s word until a record backs it. Open the
        evidence, then approve or reject.
      </p>
      {!isApprover && pending > 0 && (
        <p className="mt-2 text-sm">{isLeaver ? "The leaver can never approve." : `Only ${approverLabel} can approve findings.`}</p>
      )}
      <ul className="mt-3 grid gap-2">
        {shown.map((f) => <FindingCard key={f.id} f={f} ws={ws} isApprover={isApprover} nextVersion={nextVersion} />)}
      </ul>
    </section>
  );
}

function FindingCard({ f, ws, isApprover, nextVersion }: { f: FindingView; ws: string; isApprover: boolean; nextVersion: number }) {
  const isPending = f.status === "pending";
  return (
    <li className={clsx("card p-3 sm:p-4", isPending && "border-l-4 border-l-warn")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-3xl text-ink">{f.statement}</p>
        <span className="flex flex-wrap gap-1.5">
          <TrustChip trust={f.trust} />
          <TierChip tier={f.tier} />
          {f.conflicting && <Chip symbol="⇄" label="Conflicting" tone="bad" />}
          {isPending && <Chip symbol="○" label="Pending" tone="plain" />}
          {f.status === "approved" && (
            f.version !== null
              ? <Chip symbol="✓" label={`Approved in v${f.version}`} tone="ok" />
              : <Chip symbol="✓" label="Approved, snapshot waiting" tone="warn" />
          )}
          {f.status === "rejected" && <Chip symbol="✕" label="Rejected" tone="bad" />}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">Closes: {f.gap} · Recorded {when(f.recordedAt)}</p>
      {f.link && (
        <p className="mt-1 text-xs text-muted">
          Link: <span className="mono break-all">{f.link}</span> (not opened by Understudy)
        </p>
      )}
      {f.fileName && (
        <p className="mt-1 text-xs text-muted">
          File: {f.fileName}{f.fileBytes !== null && `, ${Math.max(1, Math.round(f.fileBytes / 1024))} KB`}
        </p>
      )}
      {f.agrees.map((c) => (
        <p key={c.claimId} className="mt-1 text-xs text-ok">Agrees with: {c.statement} ({c.trustLabel})</p>
      ))}
      {f.disagrees.map((c) => (
        <p key={c.claimId} className="mt-1 text-xs text-bad">
          Disagrees with: {c.statement} ({c.trustLabel}). Approving this will mark both as conflicting.
        </p>
      ))}
      {f.narrowedTo && <p className="mt-1 text-xs text-muted">Visible to: {f.narrowedTo.join(", ")}</p>}
      {f.status === "approved" && f.scoreDelta && <p className="mono mt-1 text-xs text-ink-2">{f.scoreDelta}</p>}
      {f.status === "approved" && f.version === null && (
        <p className="mt-1 text-sm text-warn">
          The finding is approved, but the next snapshot is not released yet. Fix the plan below, then approve the snapshot.
        </p>
      )}
      {!isPending && f.reviewNote && <p className="mt-1 text-xs text-muted">Reason: &ldquo;{f.reviewNote}&rdquo;</p>}

      {isApprover ? (
        <FindingReview ws={ws} findingId={f.id} nextVersion={nextVersion} needsReason={f.tier === "C"} pending={isPending}>
          <Evidence f={f} />
        </FindingReview>
      ) : (
        <details className="mt-3 rounded-md border border-rule bg-paper px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Evidence</summary>
          <div className="mt-2"><Evidence f={f} /></div>
        </details>
      )}
    </li>
  );
}

function Evidence({ f }: { f: FindingView }) {
  const quote = `Answer: ${f.answer}`;
  const at = f.evidenceText.indexOf(quote);
  return (
    <div className="grid gap-2">
      <figure>
        <figcaption className="mb-1 text-xs text-muted">First weeks · the finding as recorded</figcaption>
        <pre className="whitespace-pre-wrap break-words font-sans text-[0.95rem] leading-relaxed text-ink">
          {at >= 0 ? (
            <>
              {f.evidenceText.slice(0, at)}
              <mark>{quote}</mark>
              {f.evidenceText.slice(at + quote.length)}
            </>
          ) : f.evidenceText}
        </pre>
      </figure>
      {f.fileText !== null && (
        <figure>
          <figcaption className="mb-1 text-xs text-muted">Attached file: {f.fileName}</figcaption>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-rule bg-card p-2 font-mono text-xs text-ink-2">
            {f.fileText}
          </pre>
        </figure>
      )}
    </div>
  );
}
