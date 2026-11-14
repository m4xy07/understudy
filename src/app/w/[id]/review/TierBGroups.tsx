"use client";
// Tier B by responsibility: the approver opens a group, reads its claims, then approves them
// together. The button works only after the list was opened; the server checks that again, and
// approves only the claims that were on screen (tier C, conflicts and superseded claims never).
import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { SubmitButton, useSafeActionState, type ActionState } from "@/components/ActionForm";
import { TrustChip } from "@/components/chips";
import type { Trust } from "@/lib/types";
import { approveGroupAction } from "./actions";

export interface GroupClaimItem {
  id: string;
  statement: string;
  trust: Trust;
  detail: string;
  href: string | null;
}

export interface GroupItem {
  key: string;
  title: string;
  claims: GroupClaimItem[];
}

export function TierBGroups({ ws, groups, isApprover }: { ws: string; groups: GroupItem[]; isApprover: boolean }) {
  return (
    <ul className="grid gap-2" data-testid="tier-b-groups">
      {groups.map((g) => <Group key={g.key} ws={ws} group={g} isApprover={isApprover} />)}
    </ul>
  );
}

function Group({ ws, group: g, isApprover }: { ws: string; group: GroupItem; isApprover: boolean }) {
  const [opened, setOpened] = useState(false);
  const [state, formAction] = useSafeActionState<ActionState>(approveGroupAction, { ok: true, message: null });
  const n = g.claims.length;
  return (
    <li className="card" data-testid="tier-b-group">
      <details onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) setOpened(true); }}>
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 p-3 sm:p-4">
          <span className="font-medium text-ink">{g.title}</span>
          <span className="text-sm text-muted">
            {n} pending claim{n === 1 ? "" : "s"}
            {opened && <span className="text-ok"> · list opened</span>}
          </span>
        </summary>
        <ul className="grid gap-2 border-t border-rule px-3 py-3 sm:px-4">
          {g.claims.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 text-sm">
              <span className="max-w-3xl">
                <span className="text-ink">{c.statement}</span>
                <span className="block text-xs text-muted">
                  {c.detail}
                  {c.href && (
                    <>
                      {" · "}
                      <Link href={c.href} className="text-attest underline">Open evidence</Link>
                    </>
                  )}
                </span>
              </span>
              <TrustChip trust={c.trust} />
            </li>
          ))}
        </ul>
      </details>
      {isApprover && (
        <form action={formAction} className="flex flex-wrap items-center gap-3 border-t border-rule px-3 py-3 sm:px-4">
          <input type="hidden" name="ws" value={ws} />
          <input type="hidden" name="group" value={g.key} />
          <input type="hidden" name="expanded" value={opened ? "true" : "false"} />
          <input type="hidden" name="claimIds" value={g.claims.map((c) => c.id).join(",")} />
          <SubmitButton className="btn-sm" disabled={!opened} pendingText="Approving and re-testing…">
            Approve these {n} claim{n === 1 ? "" : "s"}
          </SubmitButton>
          <span className="text-xs text-muted" aria-live="polite">
            {opened ? "To reject or edit one, use the tier B list below first." : "Open the list to approve."}
          </span>
          {state.message && (
            <p role={state.ok ? "status" : "alert"} className={clsx("basis-full text-sm", state.ok ? "text-ok" : "text-bad")}>
              <span aria-hidden="true">{state.ok ? "✓ " : "✕ "}</span>
              {state.message}
            </p>
          )}
        </form>
      )}
    </li>
  );
}
