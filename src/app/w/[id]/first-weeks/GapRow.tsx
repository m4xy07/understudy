"use client";
// One open gap on First weeks: its plan, its state, and (for the successor) the finding form.
// The server checks every rule again; this form only makes the right thing easy.
import { useActionState, useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { SubmitButton, type ActionState } from "@/components/ActionForm";
import { Chip } from "@/components/chips";
import type { OpenGapRow } from "@/lib/relay/living";
import { recordFindingAction } from "./actions";

export interface RoleChoice {
  key: string;
  label: string;
  locked: boolean;
}

const STATE_CHIP = {
  open: { symbol: "○", label: "Open", tone: "plain" },
  waiting: { symbol: "◔", label: "Waiting for review", tone: "info" },
  rejected: { symbol: "✕", label: "Finding rejected", tone: "bad" },
} as const;

export function GapRow({
  ws, row, roles, approverLabel,
}: { ws: string; row: OpenGapRow; roles: RoleChoice[]; approverLabel: string }) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [note, setNote] = useState("");
  const [example, setExample] = useState(false);
  const [state, formAction] = useActionState<ActionState, FormData>(recordFindingAction, { ok: true, message: null });
  const formId = useId();
  // Focus: into the form when it opens, back to the button on Cancel, onto the message after a save.
  const openButton = useRef<HTMLButtonElement>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const message = useRef<HTMLParagraphElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (open) formHeading.current?.focus();
    else if (cancelled.current) {
      cancelled.current = false;
      openButton.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (state.ok && state.message) message.current?.focus();
  }, [state]);
  const p = row.plan;
  const chip = row.state === "closed"
    ? { symbol: "✓", label: `Closed in v${row.closedInVersion ?? ""}`.trim(), tone: "ok" as const }
    : STATE_CHIP[row.state];
  const showForm = row.canRecord && open;

  return (
    <li className={clsx("card p-4", row.blocking && row.state === "open" && "border-l-4 border-l-warn")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-3xl font-medium text-ink">
          {row.responsibilityTitle}: {row.checkLabel}
        </p>
        <span className="flex flex-wrap gap-1.5">
          {row.blocking && <Chip symbol="■" label="Blocking" tone="bad" />}
          <Chip symbol={chip.symbol} label={chip.label} tone={chip.tone} />
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">
        {p && (p.owner || p.dueDate || p.riskNote)
          ? <>Owner: {p.owner || "not set"} · Due: {p.dueDate || "not set"} · Risk: {p.riskNote || "not set"}</>
          : "No owner set"}
      </p>
      {row.restricted && (
        <p className="mt-1 text-sm text-muted">
          <span aria-hidden="true">⊘ </span>Restricted for your role. Ask the approver ({approverLabel}).
        </p>
      )}
      {row.state === "rejected" && row.rejectedReason && (
        <p className="mt-1 text-sm text-bad">Reason: &ldquo;{row.rejectedReason}&rdquo;</p>
      )}

      {row.canRecord && !open && (
        <button ref={openButton} type="button" className="btn btn-sm mt-3" aria-expanded={false} aria-controls={formId} onClick={() => setOpen(true)}>
          Record a finding<span className="sr-only"> for {row.responsibilityTitle}: {row.checkLabel}</span>
        </button>
      )}

      {showForm && (
        <form id={formId} action={formAction} className="mt-4 grid gap-3 border-t border-rule pt-4">
          <input type="hidden" name="ws" value={ws} />
          <input type="hidden" name="responsibilityId" value={row.responsibilityId} />
          <input type="hidden" name="checkKey" value={row.checkKey} />
          <input type="hidden" name="example" value={example ? "1" : "0"} />
          <input type="hidden" name="narrow" value="1" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 ref={formHeading} tabIndex={-1} className="text-lg">What did you find?</h3>
            {row.example && (
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                onClick={() => {
                  setAnswer(row.example!.answer);
                  setNote(row.example!.note);
                  setExample(true);
                }}
              >
                Use the example finding
              </button>
            )}
          </div>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{row.needsDate ? "Date" : "Answer"}</span>
            {row.needsDate ? (
              <input type="date" name="answer" required className="field max-w-52" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            ) : (
              <input name="answer" required maxLength={300} className="field" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            )}
            <span className="text-xs text-muted">{row.needsDate ? "The next date this is due." : "The fact in a few words."}</span>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">How do you know?</span>
            <textarea name="note" rows={3} maxLength={4000} className="field" value={note} onChange={(e) => setNote(e.target.value)} />
            <span className="text-xs text-muted">Who told you, or where you saw it. Do not paste passwords.</span>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Link (optional)</span>
            <input name="link" inputMode="url" placeholder="https://" className="field" />
            <span className="text-xs text-muted">A page or document that shows it. We keep the address only. Understudy never opens it.</span>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">File (optional)</span>
            <input name="file" type="file" accept=".txt,.md,.csv,.ics,text/plain,text/markdown,text/csv,text/calendar" className="text-sm" />
            <span className="text-xs text-muted">A text file up to 200 KB: .txt, .md, .csv or .ics. Secrets are masked before it is saved.</span>
          </label>
          <fieldset className="text-sm">
            <legend className="font-medium">Who can see this</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {roles.map((r) => (
                <label key={r.key} className="inline-flex items-center gap-1.5">
                  <input type="checkbox" name="roles" value={r.key} defaultChecked disabled={r.locked} />
                  {r.label}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">You can remove roles, never add them. {approverLabel} and you always see it.</p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton pendingText="Saving…">Save finding</SubmitButton>
            <button type="button" className="btn btn-quiet" onClick={() => { cancelled.current = true; setOpen(false); }}>Cancel</button>
          </div>
        </form>
      )}

      {state.message && (
        <p ref={message} tabIndex={-1} role={state.ok ? "status" : "alert"} className={clsx("mt-3 text-sm", state.ok ? "text-ok" : "text-bad")}>
          <span aria-hidden="true">{state.ok ? "✓ " : "✕ "}</span>
          {state.message}
        </p>
      )}
    </li>
  );
}
