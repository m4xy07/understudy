import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRunStatus, getWorkspace } from "@/lib/db/queries";
import { getProgress } from "@/lib/progress";
import { getRole } from "@/lib/session";
import { getPack } from "@/lib/pack";
import { roleOptions, type WsParams } from "@/lib/page";
import { Stepper } from "@/components/Stepper";
import { RoleSwitcher } from "@/components/RoleSwitcher";
import { RunPill } from "@/components/RunPanel";

export default function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: WsParams }) {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Suspense fallback={<HeaderFallback />}>
        <WorkspaceHeader params={params} />
      </Suspense>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-8 sm:py-8">
        {children}
      </main>
      <footer className="mx-auto w-full max-w-6xl px-4 pb-8 text-xs text-muted sm:px-8">
        All demo data is synthetic. Don&apos;t upload confidential material.
      </footer>
    </div>
  );
}

function HeaderFallback() {
  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto h-[8.5rem] w-full max-w-6xl px-4 sm:px-8" />
    </header>
  );
}

async function WorkspaceHeader({ params }: { params: WsParams }) {
  const { id } = await params;
  const workspace = await getWorkspace(id);
  if (!workspace) notFound();
  const [role, progress, run] = await Promise.all([getRole(id), getProgress(id), getRunStatus(id)]);
  const pack = getPack();
  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto w-full max-w-6xl px-4 pt-4 pb-3 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 items-baseline gap-3">
            <Link href="/" className="font-serif text-lg font-semibold no-underline">
              Understudy
            </Link>
            <span className="truncate text-sm text-muted" title={workspace.name}>
              {workspace.name}
            </span>
            <RunPill ws={id} initial={run} />
          </div>
          <RoleSwitcher ws={id} role={role} roles={roleOptions(pack)} />
        </div>
        <div className="mt-3">
          <Stepper ws={id} steps={progress.steps} next={progress.next} />
        </div>
      </div>
    </header>
  );
}
