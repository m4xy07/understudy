// The recovery switch: the card the approver sees while it is off, and the banner every role
// sees while it is on. Names come from the pack; only the approver gets a button.
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { Notice } from "@/components/Notice";
import type { RecoveryState } from "@/lib/lacuna";
import { rebuildLadderAction, setUnreachableAction } from "./actions";
import { RecoveryProgress } from "./RecoveryProgress";

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  return `${date}, ${time} IST`;
}

/** Shown to the approver while recovery is off. Other roles see nothing new. */
export function RecoverySwitchCard({ ws, leaver }: { ws: string; leaver: string }) {
  return (
    <section className="card mb-5 p-4" aria-label="Recovery switch">
      <p className="eyebrow">If {leaver} has already left</p>
      <h2 className="mt-1 text-xl">Can {leaver} answer?</h2>
      <p className="mt-1 max-w-3xl text-sm text-ink-2">
        If {leaver} cannot be reached, Understudy asks the people who worked closest with {leaver}, reads the workflow files
        and history for procedures, and lists possible answers for what is left. All of it is weaker evidence than{" "}
        {leaver}&apos;s own answer and is labelled that way.
      </p>
      <ActionForm action={setUnreachableAction} hidden={{ ws, on: "1" }} className="mt-3 grid max-w-xl gap-2">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Why (optional, goes in the audit log)</span>
          <input name="note" type="text" maxLength={500} className="field" autoComplete="off" />
        </label>
        <div>
          <SubmitButton pendingText="Starting recovery…">{leaver} can&apos;t be reached</SubmitButton>
        </div>
        <RecoveryProgress />
      </ActionForm>
    </section>
  );
}

/** Shown to every role while recovery is on. */
export function RecoveryBanner({
  ws, state, leaver, approver, isApprover, isLeaver,
}: { ws: string; state: RecoveryState; leaver: string; approver: string; isApprover: boolean; isLeaver: boolean }) {
  return (
    <div className="mb-5">
      <Notice tone="warn" title={`${leaver} can't be reached`}>
        <p>
          Switched on by {approver} on {when(state.at)}.{state.note ? ` Reason: ${state.note}` : ""}
        </p>
        {isLeaver ? (
          <p className="mt-1">
            You are marked as unreachable, so your answer boxes are closed. Only {approver} can change this.
          </p>
        ) : isApprover ? (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            <ActionForm action={setUnreachableAction} hidden={{ ws, on: "0" }}>
              <SubmitButton className="btn-sm" pendingText="Switching back…">
                {leaver} is back. Use the normal flow
              </SubmitButton>
            </ActionForm>
            <ActionForm action={rebuildLadderAction} hidden={{ ws }}>
              <SubmitButton className="btn-quiet btn-sm" pendingText="Rebuilding…">
                Rebuild the ladder
              </SubmitButton>
            </ActionForm>
          </div>
        ) : (
          <p className="mt-1">Only {approver} can change this.</p>
        )}
      </Notice>
    </div>
  );
}
