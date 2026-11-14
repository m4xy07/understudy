"use client";
// The approver's forms for one message: widen, limit again, and limit by hand.
// Each opens in place, posts to a server action and shows the action's answer. The submit button
// is disabled while the action runs, and the action itself ignores a repeated submit.
import { useActionState, useId, useState } from "react";
import { useFormStatus } from "react-dom";
import clsx from "clsx";
import { limitAction, widenAction, type ActionState } from "./actions";

const START: ActionState = { ok: true, message: null };

function Submit({ children, pendingText }: { children: React.ReactNode; pendingText: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-sm" disabled={pending} aria-busy={pending}>
      {pending ? pendingText : children}
    </button>
  );
}

function Message({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return (
    <p role={state.ok ? "status" : "alert"} className={clsx("mt-2 text-sm", state.ok ? "text-ok" : "text-bad")}>
      <span aria-hidden="true">{state.ok ? "⟳ " : "✕ "}</span>
      {state.message}
    </p>
  );
}

export interface RoleOption {
  key: string;
  label: string;
  /** Already sees the message: ticked and locked. */
  locked: boolean;
}

export function WidenForm({
  ws, segment, sourceName, roles,
}: { ws: string; segment: string; sourceName: string; roles: RoleOption[] }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"source" | "choose">("source");
  const [state, action] = useActionState(widenAction, START);
  const id = useId();

  if (!open) {
    return (
      <div>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setOpen(true)}>Widen</button>
        <Message state={state} />
      </div>
    );
  }
  return (
    <form action={action} className="mt-2 rounded-md border border-rule bg-paper p-3" aria-labelledby={`${id}-h`}>
      <input type="hidden" name="ws" value={ws} />
      <input type="hidden" name="segment" value={segment} />
      {roles.filter((r) => r.locked).map((r) => <input key={r.key} type="hidden" name="keep" value={r.key} />)}
      <h4 id={`${id}-h`} className="font-semibold">Widen who can see this</h4>
      <fieldset className="mt-2 grid gap-1.5 text-sm">
        <legend className="sr-only">Who should see it</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="mode" value="source" checked={mode === "source"} onChange={() => setMode("source")} />
          Everyone who can see {sourceName}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="mode" value="choose" checked={mode === "choose"} onChange={() => setMode("choose")} />
          Choose roles
        </label>
        {mode === "choose" && (
          <div className="ml-6 flex flex-wrap gap-x-4 gap-y-1">
            {roles.map((r) => (
              <label key={r.key} className={clsx("flex items-center gap-1.5", r.locked && "text-muted")}>
                <input type="checkbox" name="roles" value={r.key} defaultChecked={r.locked} disabled={r.locked} />
                {r.label}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <label htmlFor={`${id}-why`} className="mt-3 block text-sm font-medium">Why is this safe to widen?</label>
      <textarea id={`${id}-why`} name="reason" rows={2} required minLength={10} maxLength={500} className="field mt-1" aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted">At least 10 characters. Saved in the audit log.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Submit pendingText="Widening…">Widen and re-run</Submit>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setOpen(false)}>Keep it limited</button>
      </div>
      <Message state={state} />
    </form>
  );
}

export interface CategoryOption {
  key: string;
  label: string;
}

/**
 * Limit a message by hand. With `fixed` the kind of content is already known (limit again);
 * without it the approver picks the kind.
 */
export function LimitForm({
  ws, segment, button, options, fixed,
}: { ws: string; segment: string; button: string; options: CategoryOption[]; fixed?: string[] }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(limitAction, START);
  const id = useId();

  if (!open) {
    return (
      <div>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setOpen(true)}>{button}</button>
        <Message state={state} />
      </div>
    );
  }
  return (
    <form action={action} className="mt-2 rounded-md border border-rule bg-paper p-3" aria-labelledby={`${id}-h`}>
      <input type="hidden" name="ws" value={ws} />
      <input type="hidden" name="segment" value={segment} />
      <h4 id={`${id}-h`} className="font-semibold">Limit who can see this</h4>
      {fixed ? (
        fixed.map((c) => <input key={c} type="hidden" name="category" value={c} />)
      ) : (
        <fieldset className="mt-2 grid gap-1.5 text-sm">
          <legend className="font-medium">What kind of content is this?</legend>
          {options.map((o, i) => (
            <label key={o.key} className="flex items-center gap-2">
              <input type="radio" name="category" value={o.key} defaultChecked={i === 0} required />
              {o.label}
            </label>
          ))}
        </fieldset>
      )}
      <label htmlFor={`${id}-why`} className="mt-3 block text-sm font-medium">Why?</label>
      <textarea id={`${id}-why`} name="reason" rows={2} required minLength={10} maxLength={500} className="field mt-1" aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted">At least 10 characters. Saved in the audit log.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Submit pendingText="Limiting…">Limit and re-run</Submit>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <Message state={state} />
    </form>
  );
}
