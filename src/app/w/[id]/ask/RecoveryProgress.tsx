"use client";
// What the recovery switch is doing while it works (it can take up to half a minute when the model
// is asked live). The three steps are the real order of the work on the server; the page cannot
// see inside the request, so the step shown moves on by time and the last one stays until it ends.
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import clsx from "clsx";

export const RECOVERY_STEPS = [
  "Finding who is close to each gap",
  "Reading files and history",
  "Listing options",
] as const;

/** Seconds after which the next step is shown. */
const STEP_AT = [0, 4, 12];

export function RecoveryProgress() {
  const { pending } = useFormStatus();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => {
      clearInterval(t);
      setSeconds(0);
    };
  }, [pending]);
  if (!pending) return null;
  const current = STEP_AT.filter((at) => seconds >= at).length - 1;
  return (
    <div role="status" aria-live="polite" className="rounded-md border border-rule bg-paper px-3 py-2 text-sm" data-testid="recovery-progress">
      <p className="font-medium text-ink">Working without the leaver. This can take up to half a minute.</p>
      <ol className="mt-1 grid gap-0.5">
        {RECOVERY_STEPS.map((label, i) => (
          <li key={label} className={clsx(i < current ? "text-ok" : i === current ? "text-ink" : "text-muted")}>
            <span aria-hidden="true" className={clsx("mr-1.5 inline-block w-4 text-center", i === current && "animate-spin motion-reduce:animate-none")}>
              {i < current ? "✓" : i === current ? "◌" : "·"}
            </span>
            {label}
            <span className="sr-only">{i < current ? " (done)" : i === current ? " (in progress)" : " (next)"}</span>
          </li>
        ))}
      </ol>
      <p className="mt-1 text-xs text-muted">{seconds} s so far. Stay on this page; it updates by itself.</p>
    </div>
  );
}
