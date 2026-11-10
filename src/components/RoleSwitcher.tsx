"use client";
// "Viewing as": sets the us_role_<workspaceId> cookie through a server action, then refreshes.
import { useTransition } from "react";
import { setRole } from "@/app/w/actions";
import type { RoleKey } from "@/lib/types";

export function RoleSwitcher({
  ws, role, roles,
}: { ws: string; role: RoleKey; roles: { key: RoleKey; label: string }[] }) {
  const [pending, start] = useTransition();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="whitespace-nowrap text-muted">Viewing as</span>
      <select
        className="field min-h-9 w-auto py-1 pr-8 font-medium"
        value={role}
        disabled={pending}
        aria-busy={pending}
        onChange={(e) => {
          const next = e.target.value;
          start(async () => {
            await setRole(ws, next);
          });
        }}
      >
        {roles.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
      {pending && <span className="text-xs text-muted">Switching…</span>}
    </label>
  );
}
