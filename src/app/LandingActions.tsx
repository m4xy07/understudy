"use client";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { openDemo, startEmpty } from "./actions";

type State = { error: string } | void;

function Submit({ children, pendingText, quiet }: { children: React.ReactNode; pendingText: string; quiet?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={quiet ? "btn btn-quiet min-h-12 px-5 text-base" : "btn min-h-12 px-5 text-base"} disabled={pending} aria-busy={pending}>
      {pending ? pendingText : children}
    </button>
  );
}

export function LandingActions() {
  const [demoState, demoAction] = useActionState<State, FormData>(async () => openDemo(), undefined);
  const [emptyState, emptyAction] = useActionState<State, FormData>(async () => startEmpty(), undefined);
  const error = (demoState && demoState.error) || (emptyState && emptyState.error) || null;
  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <form action={demoAction}>
          <Submit pendingText="Creating your private copy…">Open the robotics-club demo</Submit>
        </form>
        <form action={emptyAction}>
          <Submit pendingText="Creating an empty workspace…" quiet>
            Start empty and upload my files
          </Submit>
        </form>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          <span aria-hidden="true">✕ </span>
          {error}
        </p>
      )}
    </div>
  );
}
