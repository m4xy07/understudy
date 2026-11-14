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

export interface DemoButton {
  packId: string;
  label: string;
  pendingText: string;
  title: string;
  blurb: string;
  /** Role labels of the setting, in pack order: shown on the card so the visitor sees what "Viewing as" offers. */
  roles: string[];
}

/** One card per demo pack (from packs/index.json, passed in by the server page), then "start empty". */
export function LandingActions({ demos }: { demos: DemoButton[] }) {
  const [demoState, demoAction] = useActionState<State, FormData>(
    async (_prev, form) => openDemo(String(form.get("pack") ?? "")),
    undefined,
  );
  const [emptyState, emptyAction] = useActionState<State, FormData>(async () => startEmpty(), undefined);
  const error = (demoState && demoState.error) || (emptyState && emptyState.error) || null;
  return (
    <div>
      <h2 id="demos-h" className="eyebrow">{demos.length === 1 ? "Try the demo" : "Try a demo"}</h2>
      <ul aria-labelledby="demos-h" className={demos.length > 1 ? "mt-3 grid gap-4 sm:grid-cols-2" : "mt-3 grid gap-4"}>
        {demos.map((d) => (
          <li key={d.packId} className="card flex flex-col p-5">
            <h3 className="text-lg">{d.title}</h3>
            <p className="mt-2 text-sm text-ink-2">{d.blurb}</p>
            <p className="mt-3 text-xs text-muted">
              <span className="font-medium text-ink-2">Roles:</span> {d.roles.join(" · ")}
            </p>
            <form action={demoAction} className="mt-auto pt-4">
              <input type="hidden" name="pack" value={d.packId} />
              <Submit pendingText={d.pendingText}>{d.label}</Submit>
            </form>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-ink-2">
        No sign-up needed. One click opens a private copy with the pipeline already running.
        Switch roles any time with &ldquo;Viewing as&rdquo; in the top bar.
        {demos.length > 1 && " Same seven steps in each demo; different roles, checklists and sources."}
      </p>
      <form action={emptyAction} className="mt-5">
        <Submit pendingText="Creating an empty workspace…" quiet>
          Start empty and upload my files
        </Submit>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          <span aria-hidden="true">✕ </span>
          {error}
        </p>
      )}
    </div>
  );
}
