// Fetch a live public GitHub repo into the same shape as a demo's github export:
// commits.json (last 100 commits; changed files only for the newest 30 to save rate limit),
// files/README*, files/.github/workflows/*, and up to 25 small text files (< 50 KB).
import type { SourceFile } from "./adapters/common";

export type GithubFetchErrorCode = "bad_url" | "not_found" | "rate_limited" | "forbidden" | "network";

export class GithubFetchError extends Error {
  constructor(
    public readonly code: GithubFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GithubFetchError";
  }
}

export interface FetchRepoOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  maxCommits?: number;
  detailCommits?: number;
  maxFiles?: number;
}

const MAX_FILE_BYTES = 50 * 1024;
const TEXT_EXT = /\.(md|markdown|txt|ya?ml|json|toml|ini|cfg|conf|env\.example|sh|py|js|ts|c|h|cpp|hpp|ino|rs|go|java|kt|rb|csv|ics|xml|properties|gradle|cmake|mk)$/i;
const TEXT_NAMES = /(^|\/)(Makefile|Dockerfile|CODEOWNERS|LICENSE|\.env\.example|\.gitignore|platformio\.ini)$/i;

export function parseRepoUrl(url: string): { owner: string; repo: string } {
  const s = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+)(?:\/.*)?$/i.exec(s) ??
    /^(?:git@github\.com:)([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+)$/i.exec(s) ??
    /^([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+)$/.exec(s);
  if (!m) throw new GithubFetchError("bad_url", `Not a GitHub repository URL: "${url}". Use https://github.com/<owner>/<repo>.`);
  return { owner: m[1], repo: m[2] };
}

function filePriority(path: string): number {
  const p = path.toLowerCase();
  if (p.startsWith("docs/") || p.includes("/docs/")) return 0;
  if (/\.(md|markdown|txt)$/.test(p)) return 1;
  if (/\.(ya?ml|toml|ini|cfg|conf|json|env\.example|properties)$/.test(p) || TEXT_NAMES.test(path)) return 2;
  if (p.startsWith("config") || p.includes("/config")) return 2;
  return 3;
}

export async function fetchPublicRepo(url: string, opts: FetchRepoOptions = {}): Promise<SourceFile[]> {
  const { owner, repo } = parseRepoUrl(url);
  const doFetch = opts.fetchImpl ?? fetch;
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  const maxCommits = opts.maxCommits ?? 100;
  const detailCommits = opts.detailCommits ?? 30;
  const maxFiles = opts.maxFiles ?? 25;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "understudy-handover",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function api<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`https://api.github.com${path}`, { headers });
    } catch (e) {
      throw new GithubFetchError("network", `Could not reach GitHub: ${(e as Error).message}`);
    }
    if (res.ok) return (await res.json()) as T;
    const remaining = res.headers.get("x-ratelimit-remaining");
    if ((res.status === 403 || res.status === 429) && (remaining === "0" || res.status === 429)) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const when = Number.isFinite(reset) && reset > 0 ? ` Resets at ${new Date(reset * 1000).toISOString()}.` : "";
      throw new GithubFetchError("rate_limited", `GitHub API rate limit reached.${when} Set GITHUB_TOKEN to raise the limit.`);
    }
    if (res.status === 404) {
      throw new GithubFetchError("not_found", `Repository ${owner}/${repo} was not found or is private. Only public repositories can be fetched.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new GithubFetchError("forbidden", `GitHub refused access to ${owner}/${repo} (HTTP ${res.status}). Check GITHUB_TOKEN or use a public repository.`);
    }
    throw new GithubFetchError("network", `GitHub API error ${res.status} for ${path}`);
  }

  async function raw(branch: string, path: string): Promise<string | null> {
    try {
      const res = await doFetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return null;
      const text = await res.text();
      return text.includes("\u0000") ? null : text;
    } catch {
      return null;
    }
  }

  const meta = await api<{ default_branch: string; private?: boolean }>(`/repos/${owner}/${repo}`);
  if (meta.private) throw new GithubFetchError("not_found", `Repository ${owner}/${repo} is private. Only public repositories can be fetched.`);
  const branch = meta.default_branch || "main";

  type ApiCommit = { sha: string; commit: { message: string; author: { name: string; email: string; date: string } | null } };
  const list = await api<ApiCommit[]>(`/repos/${owner}/${repo}/commits?per_page=${Math.min(100, maxCommits)}&sha=${encodeURIComponent(branch)}`);
  const commits = await Promise.all(
    list.slice(0, maxCommits).map(async (c, i) => {
      let files: { path: string; status: string }[] = [];
      if (i < detailCommits) {
        try {
          const d = await api<{ files?: { filename: string; status: string }[] }>(`/repos/${owner}/${repo}/commits/${c.sha}`);
          files = (d.files ?? []).map((f) => ({ path: f.filename, status: f.status }));
        } catch (e) {
          if (e instanceof GithubFetchError && e.code === "rate_limited") throw e;
        }
      }
      return {
        sha: c.sha,
        author_name: c.commit.author?.name ?? "unknown",
        author_email: c.commit.author?.email ?? "",
        date: c.commit.author?.date ?? "",
        message: c.commit.message,
        files,
      };
    }),
  );

  const tree = await api<{ tree: { path: string; type: string; size?: number }[]; truncated?: boolean }>(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  const blobs = tree.tree.filter((t) => t.type === "blob" && (t.size ?? 0) < MAX_FILE_BYTES);
  const readme = blobs.filter((t) => /^readme(\.[a-z]+)?$/i.test(t.path));
  const workflows = blobs.filter((t) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(t.path)).slice(0, 15);
  const chosen = new Set([...readme, ...workflows].map((t) => t.path));
  const others = blobs
    .filter((t) => !chosen.has(t.path) && (TEXT_EXT.test(t.path) || TEXT_NAMES.test(t.path)) && !/(^|\/)(node_modules|vendor|dist|build)\//.test(t.path) && !/lock|\.min\./i.test(t.path))
    .sort((a, b) => filePriority(a.path) - filePriority(b.path) || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))
    .slice(0, maxFiles);

  const out: SourceFile[] = [{ path: "commits.json", content: JSON.stringify(commits, null, 2) }];
  const picked = [...readme, ...workflows, ...others];
  const contents = await Promise.all(picked.map((t) => raw(branch, t.path)));
  picked.forEach((t, i) => {
    const c = contents[i];
    if (c !== null) out.push({ path: `files/${t.path}`, content: c });
  });
  return out;
}
