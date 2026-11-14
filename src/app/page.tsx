import { listDemoPacks } from "@/lib/pack";
import { LandingActions } from "./LandingActions";

// Server actions on this page (openDemo starts the pipeline with after()) may run long.
export const maxDuration = 300;

const STEPS = [
  { n: "1", title: "Find what the leaver actually did", body: "Reads the task board, chats, notes, calendar and code, and cites every claim back to its source.", accent: "var(--tether)" },
  { n: "2", title: "Test the draft against tomorrow's work", body: "A stand-in successor tries each responsibility and reports what still blocks them: B, then C, then K.", accent: "var(--lacuna)" },
  { n: "3", title: "Ask only what the record cannot answer", body: "Up to ten ranked questions for the leaver, then an approved snapshot that shows each role only what it may see.", accent: "var(--relay)" },
];

export default function Home() {
  // The demos on offer come from packs/index.json; each pack words its own button and blurb.
  const demos = listDemoPacks();
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-10 sm:px-8 sm:py-16">
      <header className="flex items-baseline justify-between gap-4 border-b border-rule pb-4">
        <p className="font-serif text-xl font-semibold tracking-tight">Understudy</p>
        <p className="text-xs text-muted">Team DRACONIX · Knowledge Handover</p>
      </header>

      <section className="mt-12 max-w-3xl sm:mt-20">
        <p className="eyebrow">Handover, checked</p>
        <h1 className="mt-3 text-4xl leading-[1.1] sm:text-5xl">
          A handover that knows what the leaving person actually did.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-ink-2">
          Understudy finds the work in the record, tests the draft against what the successor must do,
          asks only what the record cannot answer, and shows each role only what it may see.
        </p>
        <div className="mt-8">
          <LandingActions
            demos={demos.map((d) => ({ packId: d.id, label: d.demo.button, pendingText: d.demo.pendingText ?? "Creating your private copy…" }))}
          />
        </div>
        <p className="mt-4 flex items-start gap-2 text-sm text-muted">
          <span aria-hidden="true">!</span>
          <span>All demo data is synthetic. Don&apos;t upload confidential material.</span>
        </p>
      </section>

      <section aria-labelledby="how-h" className="mt-16 sm:mt-24">
        <h2 id="how-h" className="eyebrow">How it works</h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="card border-t-[3px] p-5" style={{ borderTopColor: s.accent }}>
              <p className="mono text-muted">{s.n}</p>
              <h3 className="mt-1 text-lg">{s.title}</h3>
              <p className="mt-2 text-sm text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <footer className="mt-auto pt-16 text-xs text-muted">
        {demos.map((d) => (
          <p key={d.id}>
            <span className="font-medium text-ink-2">{d.demo.title}.</span> {d.demo.blurb}
          </p>
        ))}
        <p className={demos.length ? "mt-1" : undefined}>You get a private copy; nobody else sees your approvals.</p>
      </footer>
    </main>
  );
}
