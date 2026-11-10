"use client";
// The seven-step stepper: done / current / next, with a one-line "what to do next" hint.
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import clsx from "clsx";
import type { StepInfo } from "@/lib/progress";

const ACCENT: Record<StepInfo["module"], string> = {
  tether: "var(--tether)",
  attest: "var(--attest)",
  lacuna: "var(--lacuna)",
  relay: "var(--relay)",
};

function currentKey(pathname: string, view: string | null): StepInfo["key"] | null {
  const seg = pathname.split("/")[3] ?? "";
  if (seg === "claims" || seg === "source") return view === "verify" ? "verify" : "claims";
  if (["connect", "test", "ask", "review", "handover"].includes(seg)) return seg as StepInfo["key"];
  return null;
}

export function Stepper({ ws, steps, next }: { ws: string; steps: StepInfo[]; next: StepInfo | null }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = currentKey(pathname, params.get("view"));
  const currentStep = steps.find((s) => s.key === current) ?? null;
  const hint = next ?? null;

  return (
    <nav aria-label="Handover steps" className="w-full">
      <ol className="flex w-full gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
        {steps.map((s, i) => {
          const isCurrent = s.key === current;
          const isNext = !isCurrent && next?.key === s.key;
          return (
            <li key={s.key} className="min-w-[5.5rem] flex-1">
              <Link
                href={`/w/${ws}/${s.href}`}
                aria-current={isCurrent ? "step" : undefined}
                className={clsx(
                  "group flex h-full flex-col gap-0.5 rounded-md border-t-[3px] px-2 py-1.5 text-left no-underline transition-colors",
                  isCurrent ? "bg-card shadow-[0_0_0_1px_var(--rule)]" : "hover:bg-paper-2",
                )}
                style={{ borderTopColor: s.done || isCurrent ? ACCENT[s.module] : "var(--rule)" }}
              >
                <span className="flex items-center gap-1 text-[0.7rem] font-semibold uppercase tracking-wider text-muted">
                  <span className="mono">{i + 1}</span>
                  {s.done ? (
                    <span className="text-ok">
                      <span aria-hidden="true">✓</span> Done
                    </span>
                  ) : isNext ? (
                    <span className="text-ink">
                      <span aria-hidden="true">→</span> Next
                    </span>
                  ) : isCurrent ? (
                    <span className="text-ink">Here</span>
                  ) : (
                    <span>To do</span>
                  )}
                </span>
                <span className={clsx("text-sm font-medium", isCurrent ? "text-ink" : "text-ink-2")}>{s.label}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-sm text-ink-2" aria-live="polite">
        {hint ? (
          <>
            <span className="font-semibold">Next: {hint.label}.</span> {hint.hint}{" "}
            {current !== hint.key && (
              <Link href={`/w/${ws}/${hint.href}`} className="font-medium text-attest underline">
                Go to {hint.label}
              </Link>
            )}
          </>
        ) : currentStep ? (
          <>
            <span className="font-semibold">All steps done.</span> Switch roles to compare what each one sees.
          </>
        ) : null}
      </p>
    </nav>
  );
}
