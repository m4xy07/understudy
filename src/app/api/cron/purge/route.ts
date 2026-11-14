// GET /api/cron/purge: the scheduled cleanup of old workspaces (vercel.json crons, once a day).
// Vercel sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set; anything else is
// refused. Without CRON_SECRET the route is closed: there is no default secret.
// ?dry=1 reports how many workspaces would go and deletes nothing.
import { timingSafeEqual } from "node:crypto";
import { purgeStale } from "@/lib/pipeline/cleanup";

export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function GET(req: Request) {
  if (!authorised(req)) return Response.json({ ok: false, error: "Not authorised." }, { status: 401, headers: noStore });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  try {
    const res = await purgeStale({ dry });
    return Response.json({ ok: true, ...res }, { headers: noStore });
  } catch (err) {
    console.error("[cron purge] failed", err);
    return Response.json({ ok: false, error: "The cleanup could not run." }, { status: 500, headers: noStore });
  }
}
