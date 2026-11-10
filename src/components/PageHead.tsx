// Page title block with the module accent (Tether, Attest, Lacuna, Relay).
const ACCENT = {
  tether: { color: "var(--tether)", name: "Tether" },
  attest: { color: "var(--attest)", name: "Attest" },
  lacuna: { color: "var(--lacuna)", name: "Lacuna" },
  relay: { color: "var(--relay)", name: "Relay" },
} as const;

export function PageHead({
  module, step, title, children, aside,
}: {
  module: keyof typeof ACCENT;
  step: string;
  title: string;
  children?: React.ReactNode;
  aside?: React.ReactNode;
}) {
  const a = ACCENT[module];
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
      <div className="max-w-3xl">
        <p className="eyebrow" style={{ color: a.color }}>
          {step} · {a.name}
        </p>
        <h1 className="mt-1 text-3xl sm:text-[2.1rem]">{title}</h1>
        {children && <div className="mt-2 text-ink-2">{children}</div>}
      </div>
      {aside}
    </div>
  );
}

export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="animate-pulse" role="status" aria-live="polite">
      <div className="h-4 w-32 rounded bg-paper-2" />
      <div className="mt-3 h-8 w-2/3 rounded bg-paper-2" />
      <div className="mt-6 h-40 rounded-lg bg-paper-2" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
