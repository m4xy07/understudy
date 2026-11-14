"use client";
// Tier C review: the evidence opens inline, and only after it was opened (and a reason of 10+
// characters is written) can the approver decide. The server checks both again.
import { useId, useState } from "react";
import clsx from "clsx";
import { SubmitButton, useSafeActionState, type ActionState } from "@/components/ActionForm";
import { SegmentText } from "@/components/SegmentText";
import { reviewClaimAction } from "./actions";

export interface EvidenceItem {
  segmentId: string;
  quote: string | null;
  text: string | null; // null: not visible to this role (or gone)
  sourceName: string;
  when: string;
  href: string;
}

const MIN = 10;

export function TierCReview({ ws, claimId, evidence }: { ws: string; claimId: string; evidence: EvidenceItem[] }) {
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState("");
  const [state, formAction] = useSafeActionState<ActionState>(reviewClaimAction, { ok: true, message: null });
  const panelId = useId();
  const noteId = useId();
  const reasonOk = note.trim().length >= MIN;

  return (
    <div className="mt-3">
      <button
        type="button"
        className={clsx("btn btn-sm", opened ? "btn-quiet" : "")}
        aria-expanded={opened}
        aria-controls={panelId}
        onClick={() => setOpened(true)}
        disabled={opened}
      >
        <span aria-hidden="true">{opened ? "✓ " : "▸ "}</span>
        {opened ? "Evidence opened" : `Open evidence (${evidence.length})`}
      </button>

      {opened && (
        <div id={panelId} className="mt-3 grid gap-2" role="region" aria-label="Evidence">
          {evidence.length === 0 && <p className="text-sm text-warn">No accepted citation on this claim.</p>}
          {evidence.map((e) => (
            <figure key={e.segmentId} className="rounded-md border border-rule bg-paper px-3 py-2">
              <figcaption className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span>
                  {e.sourceName} · {e.when}
                </span>
                <a href={e.href} className="text-attest underline">
                  Open source
                </a>
              </figcaption>
              {e.text === null ? (
                <p className="text-sm text-muted">This segment is not visible to your role.</p>
              ) : (
                <SegmentText text={e.text} quote={e.quote} />
              )}
            </figure>
          ))}
        </div>
      )}

      <form action={formAction} className="mt-3 grid gap-2">
        <input type="hidden" name="ws" value={ws} />
        <input type="hidden" name="claimId" value={claimId} />
        <input type="hidden" name="evidenceOpened" value={opened ? "true" : "false"} />
        <label htmlFor={noteId} className="text-sm">
          Why is this right (or wrong)? <span className="text-muted">At least {MIN} characters.</span>
        </label>
        <textarea
          id={noteId}
          name="note"
          rows={2}
          className="field min-h-16"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={!opened}
          placeholder={opened ? "e.g. The task board and the calendar both say so." : "Open the evidence first."}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton name="decision" value="approved" className="btn-sm" disabled={!opened || !reasonOk} pendingText="Saving…">
            Approve
          </SubmitButton>
          <SubmitButton name="decision" value="rejected" className="btn-quiet btn-sm" disabled={!opened || !reasonOk} pendingText="Saving…">
            Reject
          </SubmitButton>
          <span className="text-xs text-muted" aria-live="polite">
            {!opened ? "Open the evidence to decide." : reasonOk ? "Ready." : `${Math.max(0, MIN - note.trim().length)} more characters.`}
          </span>
        </div>
        {state.message && (
          <p role={state.ok ? "status" : "alert"} className={clsx("text-sm", state.ok ? "text-ok" : "text-bad")}>
            <span aria-hidden="true">{state.ok ? "✓ " : "✕ "}</span>
            {state.message}
          </p>
        )}
      </form>
    </div>
  );
}
