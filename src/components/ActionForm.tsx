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

export const ACTION_FAILED =
  "That did not go through: the server did not answer or hit an error. Nothing was saved twice. Reload the page to see the current state, then try again.";

/** Next.js control-flow errors (redirect, not found) must keep propagating. */
function isControlFlow(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && /^NEXT_(REDIRECT|HTTP_ERROR_FALLBACK|NOT_FOUND)/.test(digest);
}

/**
 * useActionState for a server action that returns { ok, message, ... }. A rejected call (network
 * drop, a server exception, a timeout) comes back as { ok: false, message } in the same shape, so
 * the form shows a sentence and stays usable.
 */
export function useSafeActionState<S extends { ok: boolean; message: string | null }>(
  action: (prev: S, form: FormData) => Promise<S>, initial: S,
): [state: S, dispatch: (payload: FormData) => void, isPending: boolean] {
  const safe = async (prev: Awaited<S>, form: FormData): Promise<S> => {
    try {
      return await action(prev as S, form);
    } catch (err) {
      if (isControlFlow(err)) throw err;
      console.error("action failed", err);
      return { ...(prev as S), ok: false, message: ACTION_FAILED };
    }
  };
  const [state, dispatch, pending] = useActionState<S, FormData>(safe, initial as Awaited<S>);
  return [state as S, dispatch, pending];
}

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
  const [state, formAction] = useSafeActionState<ActionState>(action, { ok: true, message: null });
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
