// Slack export: users.json + one <channel>.json per channel (or <channel>/<date>.json, the
// official export layout). Thread = "#channel". meta.replyTo = segment id of the parent message.
import type { AdapterResult } from "@/lib/types";
import { toIstIso } from "../ids";
import { basename, posix, ResultBuilder, stripBom, type AdapterContext, type SourceFile } from "./common";

interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  profile?: { email?: string; real_name?: string; display_name?: string };
}

interface SlackMessage {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_to?: string;
  subtype?: string;
  user_profile?: { real_name?: string };
}

const META_FILES = new Set(["users.json", "channels.json", "groups.json", "dms.json", "mpims.json", "integration_logs.json", "canvases.json", "org_users.json"]);
const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "bot_add", "pinned_item"]);

export function channelOf(path: string): string {
  const p = posix(path);
  const base = basename(p);
  if (/^\d{4}-\d{2}-\d{2}\.json$/i.test(base)) {
    const parts = p.split("/");
    return parts.length >= 2 ? parts[parts.length - 2] : base.replace(/\.json$/i, "");
  }
  return base.replace(/\.json$/i, "");
}

function slackTsToIso(ts: string): string | null {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return toIstIso(Math.floor(n * 1000));
}

export function parseSlack(files: SourceFile[], ctx: AdapterContext): AdapterResult {
  const b = new ResultBuilder(ctx, "slack");
  const users = new Map<string, { personId: string; name: string }>();

  const usersFile = files.find((f) => basename(f.path).toLowerCase() === "users.json");
  if (usersFile) {
    try {
      const list = JSON.parse(stripBom(usersFile.content)) as SlackUser[];
      for (const u of Array.isArray(list) ? list : []) {
        if (!u || typeof u.id !== "string") continue;
        const rawName = u.real_name || u.profile?.real_name || u.profile?.display_name || u.name || u.id;
        const displayName = b.mask(rawName);
        const p = ctx.people.resolve({ displayName, email: u.profile?.email ?? null, scope: ctx.sourceId });
        users.set(u.id, { personId: p.id, name: displayName });
        b.touch(p.id);
      }
    } catch (e) {
      b.reject(0, usersFile.path, `users.json is not valid JSON: ${(e as Error).message}`);
    }
  } else {
    b.reject(0, "users.json", "users.json missing: authors resolved by user id only");
  }

  const channelFiles = files
    .filter((f) => /\.json$/i.test(f.path) && !META_FILES.has(basename(f.path).toLowerCase()))
    .sort((a, c) => posix(a.path).localeCompare(posix(c.path)));

  const byChannel = new Map<string, { msg: SlackMessage; line: number; file: string }[]>();
  for (const f of channelFiles) {
    let list: unknown;
    try {
      list = JSON.parse(stripBom(f.content));
    } catch (e) {
      b.reject(0, f.path, `not valid JSON: ${(e as Error).message}`);
      continue;
    }
    if (!Array.isArray(list)) {
      b.reject(0, f.path, "channel file must be a JSON array of messages");
      continue;
    }
    const ch = channelOf(f.path);
    const arr = byChannel.get(ch) ?? [];
    list.forEach((m, i) => arr.push({ msg: m as SlackMessage, line: i + 1, file: f.path }));
    byChannel.set(ch, arr);
  }

  for (const [channel, entries] of byChannel) {
    const thread = `#${channel}`;
    const sorted = [...entries].sort((x, y) => Number(x.msg.ts ?? 0) - Number(y.msg.ts ?? 0));
    const idByTs = new Map<string, string>();
    const pending: { segIndex: number; parentTs: string }[] = [];

    for (const { msg, line } of sorted) {
      if (!msg || typeof msg !== "object") {
        b.reject(line, String(msg), "message is not an object");
        continue;
      }
      if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) continue;
      const ts = msg.ts ? slackTsToIso(String(msg.ts)) : null;
      if (!ts) {
        b.reject(line, JSON.stringify(msg).slice(0, 300), "missing or invalid ts");
        continue;
      }
      const text = renderSlackText(msg.text ?? "", users);
      if (!text.trim()) continue;
      let authorId: string | null = null;
      if (msg.user) {
        const u = users.get(msg.user);
        if (u) authorId = u.personId;
        else {
          const name = msg.user_profile?.real_name ? b.mask(msg.user_profile.real_name) : msg.user;
          authorId = ctx.people.resolve({ displayName: name, scope: ctx.sourceId }).id;
        }
      }
      const parentTs = msg.reply_to && msg.reply_to !== msg.ts ? msg.reply_to : msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : null;
      const meta: Record<string, unknown> = { channel, slackTs: String(msg.ts) };
      if (msg.thread_ts) meta.threadTs = String(msg.thread_ts);
      const seg = b.add({ kind: "message", ts, thread, rawText: text, authorId, meta });
      idByTs.set(String(msg.ts), seg.id);
      if (parentTs) pending.push({ segIndex: b.segments.length - 1, parentTs: String(parentTs) });
    }
    for (const p of pending) {
      const parentId = idByTs.get(p.parentTs);
      if (parentId) b.segments[p.segIndex].meta.replyTo = parentId;
      else b.segments[p.segIndex].meta.replyToMissing = p.parentTs;
    }
  }
  return b.result();
}

function renderSlackText(text: string, users: Map<string, { name: string }>): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${users.get(id)?.name ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
