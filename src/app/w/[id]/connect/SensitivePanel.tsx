// The "Sensitive content" panel on Connect: messages posted where many people can read them
// that the content classifier limited to fewer roles, with the reason and who sees them now.
// Rows are read under the viewing role's permissions (RLS); a role that cannot read a limited
// message only learns how many there are (a count from the database, nothing else).
import Link from "next/link";
import { roleLabel, type ResolvedPack } from "@/lib/pack";
import { Chip, RoleChip } from "@/components/chips";
import { sensitiveSummary, type SensitiveRow } from "@/lib/tether/visibility";
import type { RoleKey, SensitivityCategory } from "@/lib/types";
import { LimitForm, WidenForm } from "./VisibilityForms";

export const CATEGORY_CHIP: Record<SensitivityCategory, { symbol: string; label: string }> = {
  finance: { symbol: "₹", label: "Money" },
  hr: { symbol: "☷", label: "People matter" },
  health: { symbol: "✚", label: "Health" },
};

export const CATEGORY_OPTIONS = (Object.keys(CATEGORY_CHIP) as SensitivityCategory[]).map((key) => ({ key, label: CATEGORY_CHIP[key].label }));

function day(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

function foundBy(row: SensitiveRow, approverLabel: string): string {
  switch (row.stage) {
    case "model": return "Found by the model";
    case "held": return "Held: not checked yet";
    case "manual": return `Limited by ${approverLabel}`;
    case "widened": return `Widened by ${approverLabel}`;
    default: return "Found by a rule";
  }
}

export async function SensitivePanel({
  ws, role, pack, running,
}: { ws: string; role: RoleKey; pack: ResolvedPack; running: boolean }) {
  const s = await sensitiveSummary(ws, role);
  const approver = pack.approverRole;
  const approverLabel = roleLabel(approver, pack);
  const isApprover = role === approver;

  return (
    <section aria-labelledby="sens-h" className="card min-w-0 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="sens-h" className="text-xl">Sensitive content</h2>
        {isApprover && s.rows.length > 0 && (
          <p className="text-sm text-muted" data-testid="sensitive-counts">
            {s.limited} limited · {s.held} held for you to check · {s.widened} widened by you
          </p>
        )}
      </div>
      {isApprover && (
        <p className="mt-1 max-w-3xl text-sm text-muted">
          These messages were posted where many people can read them, but they look like money, people or health
          matters. Each one was limited to the roles allowed to see that kind of content before anything was stored
          or read by the model.
        </p>
      )}

      {isApprover && s.held > 0 && (
        <p role="status" className="mt-3 rounded-md border border-warn bg-[#fbf6ea] px-3 py-2 text-sm">
          <span aria-hidden="true">! </span>
          {s.held} {s.held === 1 ? "message" : "messages"} could not be checked because the model was unavailable.
          {" "}They stay limited until the approver decides.
        </p>
      )}

      {!isApprover && s.hidden > 0 && (
        <p className="mt-3 text-sm text-ink-2" data-testid="sensitive-hidden">
          <span aria-hidden="true">⊘ </span>
          {s.hidden} {s.hidden === 1 ? "message" : "messages"} in sources you can open {s.hidden === 1 ? "is" : "are"} limited
          to fewer roles. Ask the approver ({approverLabel}).
        </p>
      )}

      {s.rows.length === 0 && s.hidden === 0 && (
        <p className="mt-3 text-sm text-muted">No sensitive content found in open channels.</p>
      )}

      {s.rows.length > 0 && (
        <ul className="mt-4 grid gap-3">
          {s.rows.map((r) => {
            const widened = r.stage === "widened";
            const canWiden = r.roleSet.length < r.roleSetOriginal.length;
            return (
              <li key={r.segmentId} className="rounded-md border border-rule p-3" data-testid="sensitive-row">
                <p className="text-xs text-muted">
                  {r.sourceName} · {day(r.ts)} · {r.authorName ?? "Unknown"}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-[0.95rem] text-ink">{r.text}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {r.categories.map((c) => <Chip key={c} symbol={CATEGORY_CHIP[c].symbol} label={CATEGORY_CHIP[c].label} tone="warn" />)}
                  <Chip symbol={widened ? "↔" : r.stage === "held" ? "!" : "⊘"} label={foundBy(r, approverLabel)} tone={widened ? "ok" : "plain"} />
                  <Link href={`/w/${ws}/source/${r.segmentId}`} className="ml-1 text-xs text-attest underline">Open message</Link>
                </div>
                {r.reason && <p className="mt-2 text-sm text-ink-2">Why: {r.reason}</p>}
                <p className="mt-2 flex flex-wrap items-center gap-1 text-sm">
                  <span className="text-muted">Visible to:</span>
                  {r.roleSet.map((k) => <RoleChip key={k} role={k} label={roleLabel(k, pack)} />)}
                </p>
                {!widened && (
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted">
                    <span>Before:</span>
                    {r.roleSetOriginal.map((k) => <RoleChip key={k} role={k} label={roleLabel(k, pack)} />)}
                  </p>
                )}
                {widened && (
                  <div className="mt-2 text-sm">
                    {running && (
                      <p role="status" className="text-attest">
                        <span aria-hidden="true">⟳ </span>Widened. Re-running the steps that used this message.
                      </p>
                    )}
                    <p className="text-ok">
                      <span aria-hidden="true">✓ </span>
                      Widened by {approverLabel} on {day(r.changedAt)}. Reason: {r.note ?? "none given"}
                    </p>
                  </div>
                )}
                {r.stage === "manual" && r.note && <p className="mt-1 text-sm text-ink-2">Reason: {r.note}</p>}
                <div className="mt-2">
                  {isApprover ? (
                    <div className="flex flex-wrap gap-2">
                      {canWiden && (
                        <WidenForm
                          ws={ws}
                          segment={r.segmentId}
                          sourceName={r.sourceName}
                          roles={r.roleSetOriginal.map((k) => ({ key: k, label: roleLabel(k, pack), locked: r.roleSet.includes(k) }))}
                        />
                      )}
                      {widened && (
                        <LimitForm ws={ws} segment={r.segmentId} button="Limit again" options={CATEGORY_OPTIONS} fixed={r.categories} />
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted">Only the approver can widen this.</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Limited messages per source id, for the small line in the Sources table. Approver only. */
export async function limitedPerSource(ws: string, role: RoleKey): Promise<Record<string, number>> {
  return (await sensitiveSummary(ws, role)).perSource;
}
