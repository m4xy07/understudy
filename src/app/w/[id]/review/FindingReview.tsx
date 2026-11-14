"use client";
// The approver's decision on one successor finding. The evidence is shown inline; the approver
// ticks "I opened the evidence" and writes a reason. The server checks both again (tier C).
import { useActionState, useId, useState } from "react";
import clsx from "clsx";
import { SubmitButton, type ActionState } from "@/components/ActionForm";
import { decideFindingAction } from "../first-weeks/actions";

const MIN = 10;

export function FindingReview({
  ws, findingId, nextVersion, needsReason, pending, children,
}: {
  ws: string;
  findingId: string;
  nextVersion: number;
  /** Tier C: the evidence must be opened and a reason written. */
  needsReason: boolean;
  /** False once the finding is decided: the form goes, the result message stays. */
  pending: boolean;
  /** The evidence, rendered by the server. */
  children: React.ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState("");
  const [state, formAction] = useActionState<ActionState, FormData>(decideFindingAction, { ok: true, message: null });
  const noteId = useId();
  const boxId = useId();
  const reasonOk = !needsReason || note.trim().length >= MIN;
  const ready = (!needsReason || opened) && reasonOk;

  return (
    <div className="mt-3">
      <details className="rounded-md border border-rule bg-paper px-3 py-2" open={pending}>
        <summary className="cursor-pointer text-sm font-medium">Evidence</summary>
        <div className="mt-2">{children}</div>
      </details>

      {pending && (
        <form action={formAction} className="mt-3 grid gap-2">
          <input type="hidden" name="ws" value={ws} />
          <input type="hidden" name="findingId" value={findingId} />
          <input type="hidden" name="evidenceOpened" value={opened ? "true" : "false"} />
          <label htmlFor={boxId} className="inline-flex items-center gap-2 text-sm">
            <input id={boxId} type="checkbox" checked={opened} onChange={(e) => setOpened(e.target.checked)} />
            I opened the evidence
          </label>
          <label htmlFor={noteId} className="text-sm">
            Why is this right or wrong?{" "}
            <span className="text-muted">{needsReason ? `At least ${MIN} characters.` : "Optional for this finding."}</span>
          </label>
          <textarea
            id={noteId}
            name="note"
            rows={2}
            className="field min-h-16"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. I checked with the person named in the note."
          />
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton name="decision" value="approved" className="btn-sm" disabled={!ready} pendingText="Approving and re-testing…">
              Approve and release v{nextVersion}
            </SubmitButton>
            <SubmitButton name="decision" value="rejected" className="btn-quiet btn-sm" disabled={!ready} pendingText="Saving…">
              Reject
            </SubmitButton>
            <span className="text-xs text-muted" aria-live="polite">
              {needsReason && !opened ? "Tick the box once you have read the evidence."
                : reasonOk ? "Ready." : `${Math.max(0, MIN - note.trim().length)} more characters.`}
            </span>
          </div>
        </form>
      )}

      {state.message && (
        <p role={state.ok ? "status" : "alert"} className={clsx("mt-2 text-sm", state.ok ? "text-ok" : "text-bad")}>
          <span aria-hidden="true">{state.ok ? "✓ " : "✕ "}</span>
          {state.message}
        </p>
      )}
    </div>
  );
}
