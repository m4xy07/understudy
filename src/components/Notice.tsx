import clsx from "clsx";

// Visible notices for empty states and failures. Never hide an error.
export function Notice({
  tone = "info", title, children,
}: { tone?: "info" | "warn" | "error"; title?: string; children?: React.ReactNode }) {
  const symbol = tone === "error" ? "✕" : tone === "warn" ? "!" : "i";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={clsx(
        "flex gap-3 rounded-lg border px-4 py-3 text-sm",
        tone === "error" && "border-bad/40 bg-[#f6e6e7] text-bad",
        tone === "warn" && "border-warn/40 bg-[#f6eedb] text-[#5c3f0a]",
        tone === "info" && "border-rule bg-card text-ink-2",
      )}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border border-current text-xs font-semibold"
      >
        {symbol}
      </span>
      <div>
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx(title && "mt-0.5")}>{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-rule-strong bg-card px-5 py-8 text-center">
      <p className="font-serif text-lg">{title}</p>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
    </div>
  );
}
