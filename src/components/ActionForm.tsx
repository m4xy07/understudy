"use client";
// A form bound to a server action that returns { ok, message }; shows the message inline.
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import clsx from "clsx";

export interface ActionState {
  ok: boolean;
  message: string | null;
}

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

export function SubmitButton({
  children, pendingText, className, disabled, name, value,
}: {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={clsx("btn", className)}
      disabled={pending || disabled}
      aria-busy={pending}
    >
      {pending ? (pendingText ?? "Working…") : children}
    </button>
  );
}

export function ActionForm({
  action, hidden, children, className,
}: { action: Action; hidden: Record<string, string>; children: React.ReactNode; className?: string }) {
  const [state, formAction] = useActionState(action, { ok: true, message: null });
  return (
    <form action={formAction} className={className}>
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      {state.message && (
        <p role={state.ok ? "status" : "alert"} className={clsx("mt-2 text-sm", state.ok ? "text-ok" : "text-bad")}>
          <span aria-hidden="true">{state.ok ? "✓ " : "✕ "}</span>
          {state.message}
        </p>
      )}
    </form>
  );
}
