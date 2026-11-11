"use client";
// Synthesis by receiver: the successor types the critical items; the server normalises them and
// compares exactly with the approved snapshot, then (on request) records an acknowledgement.
import { useActionState, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { useFormStatus } from "react-dom";
import type { ReadbackVerdict } from "@/lib/types";
import { readbackAction } from "./actions";

export interface ReadbackState {
  ok: boolean;
  message: string | null;
  verdicts: ReadbackVerdict[] | null;
  acked: boolean;
}

export interface ReadbackField {
  key: string;
  label: string;
  type: "date" | "text" | "contact" | "command";
  hint: string;
  hasRecord: boolean;
}

function Buttons({ canAck, checked }: { canAck: boolean; checked: boolean }) {
  const { pending } = useFormStatus();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="submit" name="intent" value="check" className="btn btn-quiet" disabled={pending} aria-busy={pending}>
        {pending ? "Checking…" : "Check my read-back"}
      </button>
      {canAck && (
        <button type="submit" name="intent" value="ack" className="btn" disabled={pending || !checked}>
          Acknowledge receipt
        </button>
      )}
    </div>
  );
}

const VERDICT: Record<ReadbackVerdict["verdict"], { symbol: string; label: string; cls: string }> = {
  match: { symbol: "✓", label: "Match", cls: "border-ok/40 bg-[#e9f1ec] text-ok" },
  mismatch: { symbol: "✕", label: "Mismatch", cls: "border-bad/40 bg-[#f6e6e7] text-bad" },
  not_visible: { symbol: "⊘", label: "Nothing to check", cls: "border-hold/40 bg-[#eceef0] text-hold" },
};

export function ReadbackForm({
  ws, fields, hidden, canAck, ackNote,
}: { ws: string; fields: ReadbackField[]; hidden: number; canAck: boolean; ackNote: string | null }) {
  const [state, formAction] = useActionState<ReadbackState, FormData>(readbackAction, {
    ok: true, message: null, verdicts: null, acked: false,
  });
  const [dirty, setDirty] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const byKey = new Map((state.verdicts ?? []).map((v) => [v.key, v]));
  const checked = Boolean(state.verdicts) && !dirty;

  return (
    <form action={(fd) => { setDirty(false); return formAction(fd); }} className="grid gap-3">
      <input type="hidden" name="ws" value={ws} />
      {fields.length === 0 && <p className="text-sm text-muted">No read-back items are visible to this role.</p>}
      <ol className="grid gap-3">
        {fields.map((f, i) => {
          const v = byKey.get(f.key);
          const show = v && !dirty;
          return (
            <li key={f.key} className="grid gap-1.5 sm:grid-cols-[minmax(0,16rem)_1fr] sm:items-start sm:gap-4">
              <label htmlFor={`rb_${f.key}`} className="pt-2 text-sm font-medium">
                <span className="mono mr-1.5 text-muted">{i + 1}.</span>
                {f.label}
              </label>
              <div className="grid gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id={`rb_${f.key}`}
                    name={`rb_${f.key}`}
                    className={clsx("field min-w-0 flex-1", f.type === "command" && "mono")}
                    placeholder={f.hint}
                    autoComplete="off"
                    spellCheck={f.type === "command" ? false : undefined}
                    inputMode={f.type === "date" ? "text" : undefined}
                    value={values[f.key] ?? ""}
                    onChange={(e) => {
                      const next = e.target.value;
                      setValues((prev) => ({ ...prev, [f.key]: next }));
                      setDirty(true);
                    }}
                    aria-describedby={show ? `rbv_${f.key}` : undefined}
                  />
                  {show && (
                    <span
                      id={`rbv_${f.key}`}
                      className={clsx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", VERDICT[v.verdict].cls)}
                    >
                      <span aria-hidden="true">{VERDICT[v.verdict].symbol}</span>
                      {VERDICT[v.verdict].label}
                    </span>
                  )}
                </div>
                {show && v.verdict === "mismatch" && (
                  <p className="text-xs text-bad">
                    Read as <span className="mono">{v.normalised || "(nothing)"}</span>; the snapshot says{" "}
                    <span className="mono">{v.expected}</span>.
                  </p>
                )}
                {show && v.verdict === "match" && (
                  <p className="text-xs text-ok">
                    Read as <span className="mono">{v.normalised}</span>, exactly as approved.
                  </p>
                )}
                {(!f.hasRecord || (show && v.verdict === "not_visible")) && (
                  <p className="text-xs text-muted">
                    No approved claim for this yet. The approver can approve it on{" "}
                    <Link href={`/w/${ws}/review`} className="underline">Review</Link>.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {hidden > 0 && (
        <p className="text-sm text-muted">
          <span aria-hidden="true">⊘ </span>
          {hidden === 1 ? "1 read-back item is" : `${hidden} read-back items are`} restricted for this role and not shown.
        </p>
      )}
      <Buttons canAck={canAck} checked={checked} />
      {!canAck && ackNote && <p className="text-sm text-muted">{ackNote}</p>}
      {state.message && (
        <p role={state.ok ? "status" : "alert"} className={clsx("text-sm", state.ok ? (state.acked ? "text-ok" : "text-ink-2") : "text-bad")}>
          <span aria-hidden="true">{state.ok ? (state.acked ? "✓ " : "i ") : "✕ "}</span>
          {state.message}
        </p>
      )}
    </form>
  );
}
