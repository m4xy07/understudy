import { Suspense } from "react";
import Link from "next/link";
import { getLatestTestRun, listResponsibilities } from "@/lib/db/queries";
import { checklistFor, roleLabel } from "@/lib/pack";
import { first, loadWorkspace, type SearchParams, type WsParams } from "@/lib/page";
import { isRoleKey } from "@/lib/db/withRole";
import { rerunTestAction } from "@/app/w/actions";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Chip, CoverageChip } from "@/components/chips";
import { ScoreLegend, ScoreLine } from "@/components/Scores";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { EmptyState } from "@/components/Notice";
import type { RoleKey } from "@/lib/types";

const ORIGIN_LABEL = { task_board: "Task board", footprint: "Leaver footprint", role_template: "Role template" } as const;

export default function TestPage({ params, searchParams }: { params: WsParams; searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Test params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Test({ params, searchParams }: { params: WsParams; searchParams: SearchParams }) {
  const { id, pack } = await loadWorkspace(params);
  const sp = await searchParams;
  const asked = first(sp.target);
  const successor = pack.successorRole as RoleKey;
  const target: RoleKey = isRoleKey(asked) ? asked : successor;
  const targets: RoleKey[] = [...new Set([successor, "new_member" as RoleKey])];
  const [run, responsibilities] = await Promise.all([getLatestTestRun(id, target), listResponsibilities(id)]);
  const results = new Map((run?.results ?? []).map((r) => [`${r.responsibilityId}|${r.checkKey}`, r]));

  return (
    <>
      <PageHead
        module="lacuna"
        step="Step 4"
        title="Could the successor do this tomorrow?"
        aside={
          <ActionForm action={rerunTestAction} hidden={{ ws: id }}>
            <SubmitButton className="btn-quiet" pendingText="Testing…">Re-run test</SubmitButton>
          </ActionForm>
        }
      >
        A stand-in for the incoming role works through each responsibility using only the claims that role may see.
      </PageHead>

      <nav aria-label="Test target" className="mb-4 flex flex-wrap gap-2">
        {targets.map((t) => (
          <Link
            key={t}
            href={`/w/${id}/test?target=${t}`}
            aria-current={t === target ? "page" : undefined}
            className={t === target ? "btn btn-sm" : "btn btn-quiet btn-sm"}
          >
            {roleLabel(t, pack)}
          </Link>
        ))}
      </nav>

      <section className="card mb-6 p-4 sm:p-5" aria-label="Scores">
        <p className="eyebrow">Scores for {roleLabel(target, pack)}</p>
        <p className="mt-2 text-xl">
          <ScoreLine scores={run?.scores ?? null} provisional={run?.provisional ?? true} />
        </p>
        <div className="mt-2">
          <ScoreLegend />
        </div>
      </section>

      {responsibilities.length === 0 ? (
        <EmptyState title="No responsibilities yet.">
          Run Understudy from <Link href={`/w/${id}/connect`} className="underline">Connect</Link> to build the inventory.
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {responsibilities.map((r) => (
            <li key={r.id} className="card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg">
                  <span className="mono mr-2 text-sm text-muted">{r.key}</span>
                  {r.title}
                </h2>
                <span className="flex flex-wrap gap-1.5">
                  <Chip symbol="◇" label={ORIGIN_LABEL[r.origin]} />
                  <Chip symbol="▤" label={r.kind.replace(/_/g, " ")} />
                  {r.dueDate && <Chip symbol="◷" label={`Due ${r.dueDate}`} />}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">{r.originDetail}</p>
              <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {checklistFor(r.kind, pack).map((check) => {
                  const res = results.get(`${r.id}|${check.key}`);
                  return (
                    <li key={check.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-rule px-2.5 py-1.5 text-sm">
                      {res ? <CoverageChip coverage={res.coverage} /> : <Chip symbol="·" label="Not tested" />}
                      <span className="font-medium">{check.label}</span>
                      <span className="text-xs text-muted">
                        {check.wTag} · {check.weight === 5 ? "blocking" : check.weight === 3 ? "important" : "normal"}
                      </span>
                      {res?.note && <span className="basis-full text-xs text-muted">{res.note}</span>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
