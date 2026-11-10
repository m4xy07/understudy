import { describe, expect, it } from "vitest";
import { parseSource } from "@/lib/tether/adapters";
import { rruleText } from "@/lib/tether/adapters/ics";
import { decryptContact } from "@/lib/tether/mask";
import { norm, sha256Hex } from "@/lib/text/norm";
import type { AdapterResult, Segment } from "@/lib/types";
import { ALL_ROLES, ctx, fixture, ingestFixtures, KEYS } from "./helpers";

function invariants(r: AdapterResult) {
  for (const s of r.segments) {
    expect(s.id).toMatch(/^seg_[0-9a-f]{16}$/);
    expect(s.version).toBe(1);
    expect(s.textHash).toBe(sha256Hex(norm(s.text)));
    expect(s.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/);
    expect(s.text).not.toMatch(/@[a-z0-9-]+\.example/i); // no raw emails survive
  }
  expect(new Set(r.segments.map((s) => s.id)).size).toBe(r.segments.length);
}

const byText = (r: AdapterResult, needle: string): Segment => {
  const s = r.segments.find((x) => x.text.includes(needle));
  if (!s) throw new Error(`no segment containing "${needle}"`);
  return s;
};

describe("whatsapp", () => {
  const r = parseSource("whatsapp", fixture("whatsapp"), ctx());
  it("parses messages, continuation lines, 12-hour and 4-digit-year formats", () => {
    invariants(r);
    expect(r.segments).toHaveLength(5);
    expect(byText(r, "nice").text).toBe("nice\nwhich build was it?");
    expect(byText(r, "deploy done").ts).toBe("2026-08-19T21:05:00+05:30");
    expect(byText(r, "firmware deploy again").ts).toBe("2026-08-26T20:00:00+05:30");
    expect(r.segments.every((s) => s.thread === "Robotics Core" && s.kind === "message")).toBe(true);
  });
  it("skips system lines and media, rejects unparseable lines with a reason", () => {
    expect(r.segments.some((s) => /end-to-end|added Rahul|Media omitted/.test(s.text))).toBe(false);
    expect(r.rejected.map((x) => x.line)).toEqual([1, 10]);
    expect(r.rejected[1].reason).toMatch(/invalid date/);
  });
  it("masks secrets and phone numbers, including a phone-number author name", () => {
    expect(byText(r, "deploy done").text).toContain("password=[SECRET:password]");
    expect(byText(r, "vendor is at").text).toMatch(/\[CONTACT:c-\d+\]/);
    expect(r.maskedSecrets).toBe(1);
    const authorNames = r.people.map((p) => p.displayName);
    expect(authorNames.join(" ")).not.toMatch(/\d{5}/);
    expect(authorNames).toContain("Priya Nair");
  });
});

describe("slack", () => {
  const r = parseSource("slack", fixture("slack"), ctx());
  it("builds #channel threads with replyTo links and slackTs", () => {
    invariants(r);
    expect(r.segments).toHaveLength(5); // channel_join skipped
    const parent = byText(r, "DNS renewal");
    const reply = byText(r, "thanks");
    expect(parent.thread).toBe("#general");
    expect(reply.meta.replyTo).toBe(parent.id);
    expect(reply.meta.slackTs).toBe("1786000100.000200");
    expect(reply.text).toBe("thanks @Priya Nair");
    expect(parent.meta.replyTo).toBeUndefined();
  });
  it("feeds users.json emails into the registry so text emails become person tokens", () => {
    const priya = r.people.find((p) => p.displayName === "Priya Nair");
    expect(priya?.emailHmac).toBeTruthy();
    expect(byText(r, "deploy bot").text).toContain(`[CONTACT:${priya?.id}]`);
    expect(byText(r, "deploy bot").text).toContain("token=[SECRET:github_token]");
    expect(byText(r, "for the drive").text).toBe("secret_key = [SECRET:secret] for the drive");
    const hit = r.contacts.find((c) => c.personId === priya?.id);
    expect(hit && decryptContact(hit.valueEnc, KEYS.contactsKey)).toBe("priya.nair@robotics-club.example");
  });
});

describe("github", () => {
  const r = parseSource("github", fixture("github"), ctx());
  it("makes one commit segment per valid commit and rejects bad ones", () => {
    invariants(r);
    const commits = r.segments.filter((s) => s.kind === "commit");
    expect(commits).toHaveLength(4);
    expect(commits[0].meta.sha).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    expect(commits[2].meta.files).toEqual([".github/workflows/deploy.yml", "firmware/deploy.sh"]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(/bad date/);
    // both Priya commit identities merged by email
    expect(new Set(commits.slice(0, 3).map((c) => c.authorId)).size).toBe(1);
  });
  it("splits files by heading and top-level YAML key, thread = path", () => {
    const wf = r.segments.filter((s) => s.thread === ".github/workflows/deploy.yml");
    expect(wf.map((s) => s.meta.section)).toEqual(["name", "on", "jobs"]);
    expect(wf[1].text).toContain("cron: '0 18 * * 1'");
    expect(wf[2].text).toContain("${{ secrets.DEPLOY_SSH_KEY }}");
    const readme = r.segments.filter((s) => s.thread === "README.md");
    expect(readme.map((s) => s.meta.section)).toEqual(["Robot firmware", "Deploy"]);
    expect(byText(r, "api_token").text).toBe("api_token: [SECRET:token]");
    expect(r.segments.every((s) => s.kind !== "file" || s.meta.path === s.thread)).toBe(true);
  });
});

describe("tasks_csv", () => {
  const r = parseSource("tasks_csv", fixture("tasks"), ctx());
  it("makes one readable task segment per valid row", () => {
    invariants(r);
    expect(r.segments).toHaveLength(3);
    const t1 = byText(r, "Task T-1:");
    expect(t1.text).toBe("Task T-1: Renew club domain | status: open | owner: Priya Nair | due: 2027-03-01 | labels: dns, admin | Renew yearly before it expires");
    expect(t1.meta).toMatchObject({ taskId: "T-1", status: "open", due: "2027-03-01", labels: ["dns", "admin"] });
    expect(t1.meta.ownerId).toMatch(/^p-\d+$/);
    expect(JSON.stringify(t1.meta)).not.toContain("@");
    expect(byText(r, "Task T-2:").meta.due).toBe("2026-12-15");
    expect(byText(r, "Task T-6:").text).toContain("Order PCBs, batch 2");
    expect(byText(r, "Task T-6:").text).toMatch(/Call vendor on \[CONTACT:c-\d+\]/);
  });
  it("rejects rows with missing id/title or a bad date, with reasons", () => {
    expect(r.rejected.map((x) => [x.line, x.reason])).toEqual([
      [4, "missing id"],
      [5, "task T-4: missing title"],
      [6, 'task T-5: bad due date "2026-13-45"'],
    ]);
  });
  it("rejects a file with the wrong header", () => {
    const bad = parseSource("tasks_csv", [{ path: "b.csv", content: "id,name\n1,x\n" }], ctx());
    expect(bad.segments).toHaveLength(0);
    expect(bad.rejected[0].reason).toMatch(/header must be exactly/);
  });
});

describe("markdown", () => {
  const r = parseSource("markdown", fixture("notes"), ctx());
  it("splits by heading, dates from front matter, narrows roles by intersection", () => {
    invariants(r);
    const run = r.segments.filter((s) => s.thread === "dns-runbook.md");
    expect(run).toHaveLength(3);
    expect(run.every((s) => s.ts === "2026-09-01T00:00:00+05:30")).toBe(true);
    expect(run[0].roleSet).toEqual(["president", "tech_lead", "leaver"]); // "hacker" ignored, never widened
    expect(run[1].meta.section).toBe("Rotating the token");
    expect(run[1].text).toContain("DNS_API_TOKEN"); // a credential name is knowledge
    const welcome = r.segments.find((s) => s.thread === "welcome.md");
    expect(welcome?.roleSet).toEqual(ALL_ROLES);
    expect(run[0].authorId).toMatch(/^p-\d+$/);
  });
});

describe("ics", () => {
  const r = parseSource("ics", fixture("calendar"), ctx());
  it("makes one event segment per VEVENT with readable text", () => {
    invariants(r);
    expect(r.segments).toHaveLength(3);
    const w = byText(r, "Firmware deploy window");
    expect(w.text).toBe("Event: Firmware deploy window | when: 2026-09-07 18:00 IST | where: Workshop lab | repeats: every week on Monday");
    expect(w.thread).toBe("Robotics Club");
    expect(w.authorId).toMatch(/^p-\d+$/); // organiser
    expect(byText(r, "Competition day").meta.start).toBe("2027-02-14T09:00:00+05:30");
  });
  it("expands RRULE for 12 months from 2026-11-11, capped at 60", () => {
    const w = byText(r, "Firmware deploy window");
    const occ = w.meta.occurrences as string[];
    expect(occ[0]).toBe("2026-11-16T18:00:00+05:30");
    expect(occ.length).toBe(52);
    expect(occ.every((o) => o >= "2026-11-11" && o < "2027-11-11")).toBe(true);
    const yearly = byText(r, "Domain renewal");
    expect(yearly.meta.occurrences).toEqual(["2027-03-15T00:00:00+05:30"]);
    expect(yearly.text).toContain("repeats: every year on 15 March");
    expect(byText(r, "Competition day").meta.occurrences).toEqual([]);
  });
  it("describes rules in plain words", () => {
    expect(rruleText("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20270501T000000Z", null)).toBe("every 2 weeks on Monday and Wednesday until 2027-05-01");
    expect(rruleText("FREQ=MONTHLY;BYDAY=1FR", null)).toBe("every month on the first Friday");
    expect(rruleText("FREQ=DAILY;COUNT=60", null)).toBe("every day, 60 times");
  });
  it("caps occurrences at 60", () => {
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:d\r\nDTSTART:20261101T100000\r\nRRULE:FREQ=DAILY\r\nSUMMARY:Daily standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const d = parseSource("ics", [{ path: "d.ics", content: ics }], ctx());
    expect((d.segments[0].meta.occurrences as string[]).length).toBe(60);
  });
});

describe("all fixtures through one registry", () => {
  it("merges people across slack, github, tasks, notes and ics by email only", () => {
    const out = ingestFixtures();
    const priyas = out.people.filter((p) => p.displayName === "Priya Nair");
    expect(priyas).toHaveLength(2); // email identity + WhatsApp name-only identity
    const withEmail = priyas.find((p) => p.emailHmac)!;
    const fromEmailSources = out.sources
      .filter((s) => s.kind !== "whatsapp")
      .flatMap((s) => s.result.segments)
      .filter((s) => s.authorId === withEmail.id || s.meta.ownerId === withEmail.id);
    expect(new Set(fromEmailSources.map((s) => s.sourceKind))).toEqual(new Set(["slack", "github", "tasks_csv", "markdown", "ics"]));
    expect(out.suggestions.some((s) => s.reason === "same display name")).toBe(true);
  });
});
