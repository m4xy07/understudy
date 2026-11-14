"use client";
// Upload files or a public GitHub URL into the workspace. Posts to /api/w/[id]/{upload,github}.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RoleKey } from "@/lib/types";

const KINDS: { key: string; label: string; accept: string; multiple: boolean; hint: string }[] = [
  { key: "tasks_csv", label: "Task board (CSV)", accept: ".csv,text/csv", multiple: false, hint: "Header: id,title,status,owner,owner_email,due,labels,updated_at,description" },
  { key: "whatsapp", label: "WhatsApp chat (.txt)", accept: ".txt,text/plain", multiple: false, hint: "An exported chat, one message per line." },
  { key: "slack", label: "Slack export (JSON)", accept: ".json,application/json", multiple: true, hint: "users.json plus one <channel>.json per channel." },
  { key: "markdown", label: "Notes (Markdown)", accept: ".md,.markdown,text/markdown", multiple: true, hint: "One .md per note; optional front matter." },
  { key: "ics", label: "Calendar (.ics)", accept: ".ics,text/calendar", multiple: false, hint: "One calendar file." },
  { key: "github", label: "GitHub export (JSON + files)", accept: ".json,.md,.yml,.yaml,.txt", multiple: true, hint: "commits.json plus repository files. Or paste a public repo URL below." },
];

// Same number as the server (UPLOAD_LIMIT_BYTES in src/lib/pipeline/ingest.ts): the live host
// refuses a larger request before our code runs, so the form checks first and says why.
const LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024);
const LIMIT_TEXT = "Upload is over 4.5 MB. Split it or trim it.";

interface Result {
  ok: boolean;
  error?: string;
  sources?: { name: string; segments: number; newSegments: number; rejected: number; maskedSecrets: number; maskedContacts: number }[];
}

function summary(r: Result): string {
  const s = r.sources?.[0];
  if (!s) return "Imported.";
  return `Imported "${s.name}": ${s.segments} segments (${s.newSegments} new), ${s.rejected} rejected, ${s.maskedSecrets} ${s.maskedSecrets === 1 ? "secret" : "secrets"} and ${s.maskedContacts} ${s.maskedContacts === 1 ? "contact" : "contacts"} masked. Press Run Understudy to update claims.`;
}

export function UploadForm({ ws, roles }: { ws: string; roles: { key: RoleKey; label: string }[] }) {
  const router = useRouter();
  const [kind, setKind] = useState("tasks_csv");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [repo, setRepo] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoMsg, setRepoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const k = KINDS.find((x) => x.key === kind)!;

  // Refs, not state: a second submit in the same tick (double click, Enter twice) must see the first.
  const sending = useRef(false);
  const fetching = useRef(false);

  async function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending.current) return;
    const formEl = e.currentTarget;
    const body = new FormData(formEl);
    const picked = body.getAll("files").filter((f): f is File => typeof f !== "string");
    const total = picked.reduce((n, f) => n + f.size, 0);
    if (!picked.length || picked.every((f) => !f.name)) {
      setMsg({ ok: false, text: "Choose at least one file." });
      return;
    }
    if (total === 0) {
      setMsg({ ok: false, text: picked.length === 1 ? `"${picked[0].name}" is empty. Choose a file with content.` : "These files are all empty. Choose files with content." });
      return;
    }
    if (total > LIMIT_BYTES) {
      setMsg({ ok: false, text: `${LIMIT_TEXT} (This selection is ${(total / 1024 / 1024).toFixed(1)} MB.)` });
      return;
    }
    sending.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/w/${ws}/upload`, { method: "POST", body });
      const fallback = res.status === 413 ? LIMIT_TEXT : `Upload failed (the server answered ${res.status}). Nothing was saved; try again.`;
      const data = (await res.json().catch(() => ({ ok: false, error: fallback }))) as Result;
      setMsg(data.ok ? { ok: true, text: summary(data) } : { ok: false, text: data.error ?? fallback });
      if (data.ok) {
        formEl.reset();
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Upload failed: the server did not answer. Check your connection and try again." });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  async function onRepo(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (fetching.current) return;
    if (!repo.trim()) {
      setRepoMsg({ ok: false, text: "Paste a public GitHub repository URL." });
      return;
    }
    fetching.current = true;
    setRepoBusy(true);
    setRepoMsg(null);
    try {
      const res = await fetch(`/api/w/${ws}/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: repo }),
      });
      const data = (await res.json().catch(() => ({ ok: false, error: `Import failed (the server answered ${res.status}). Nothing was saved; try again.` }))) as Result;
      setRepoMsg(data.ok ? { ok: true, text: summary(data) } : { ok: false, text: data.error ?? "Import failed." });
      if (data.ok) router.refresh();
    } catch {
      setRepoMsg({ ok: false, text: "Import failed: the server did not answer. Check your connection and try again." });
    } finally {
      fetching.current = false;
      setRepoBusy(false);
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-5">
      <form onSubmit={onUpload} className="grid min-w-0 grid-cols-1 gap-3" aria-labelledby="up-h">
        <h3 id="up-h" className="text-lg">Upload files</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Source type</span>
            <select name="kind" className="field" value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Files (4.5 MB max)</span>
            <input key={kind} name="files" type="file" required multiple={k.multiple} accept={k.accept} className="field py-1.5 text-sm" />
          </label>
        </div>
        <p className="break-words text-xs text-muted [overflow-wrap:anywhere]">{k.hint}</p>
        <fieldset className="grid min-w-0 gap-1 text-sm">
          <legend className="font-medium">Narrow who can see this (optional)</legend>
          <p className="text-xs text-muted">Leave all unticked to share with every role. Ticking roles narrows; it never widens.</p>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {roles.map((r) => (
              <label key={r.key} className="inline-flex items-center gap-1.5">
                <input type="checkbox" name="roles" value={r.key} className="h-4 w-4" />
                {r.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <button className="btn" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm text-ok" : "text-sm text-bad"}>
            <span aria-hidden="true">{msg.ok ? "✓ " : "✕ "}</span>
            {msg.text}
          </p>
        )}
      </form>

      <form onSubmit={onRepo} className="grid gap-2 border-t border-rule pt-4" aria-labelledby="gh-h">
        <h3 id="gh-h" className="text-lg">Public GitHub repository</h3>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Repository URL</span>
          <input
            className="field"
            type="text"
            inputMode="url"
            maxLength={300}
            placeholder="https://github.com/owner/repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            required
          />
        </label>
        <div>
          <button className="btn btn-quiet" type="submit" disabled={repoBusy} aria-busy={repoBusy}>
            {repoBusy ? "Fetching…" : "Import repository"}
          </button>
        </div>
        {repoMsg && (
          <p role={repoMsg.ok ? "status" : "alert"} className={repoMsg.ok ? "text-sm text-ok" : "text-sm text-bad"}>
            <span aria-hidden="true">{repoMsg.ok ? "✓ " : "✕ "}</span>
            {repoMsg.text}
          </p>
        )}
      </form>
    </div>
  );
}
