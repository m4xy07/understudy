// Trace reader (recovery rung 2). T-U-6 to T-U-10 of docs/round3/specs/01_recovery.md, plus the CI run history.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Segment } from "@/lib/types";
import { isExactQuote } from "@/lib/attest/core/verify";
import { loadDemoSources } from "@/lib/tether/demo";
import { ingestAll } from "@/lib/tether/ingest";
import {
  calendarTraces, commitSequenceTrace, parseWorkflow, readTraces, runHistoryTraces, workflowTraces, type Trace,
} from "@/lib/tether/traces";
import { CLUB, CLUB_DEMO_DIR } from "../helpers/club";
import { FIX, KEYS, ingestFixtures } from "./helpers";

const TODAY = "2026-11-11T12:00:00+05:30";
const THRESHOLDS = { repeatMin: 3, distinctWeeksMin: 2, ownershipShare: 0.8, windowMonths: 6 };
const ENTITIES = CLUB.entities.map((e) => ({ key: e.key, label: e.label, aliases: [...e.aliases] }));

const demo = ingestAll(loadDemoSources(CLUB_DEMO_DIR).map((d, i) => ({ ...d, sourceId: `src-${i}` })), KEYS);
const demoSegments: Segment[] = demo.sources.flatMap((s) => s.result.segments);
const byId = new Map(demoSegments.map((s) => [s.id, s]));

function expectQuotesExact(trace: Trace, segs: Map<string, Segment>) {
  for (const step of trace.steps) {
    if (step.kind !== "quoted") continue;
    expect(step.citations.length, step.text).toBeGreaterThan(0);
    for (const c of step.citations) {
      const seg = segs.get(c.segmentId);
      expect(seg, `${step.text}: segment ${c.segmentId}`).toBeDefined();
      expect(isExactQuote(c.quote, seg!.text), `${step.text}: "${c.quote}"`).toBe(true);
    }
  }
}

let counter = 0;
function commit(over: { ts: string; text: string; files: string[]; authorId?: string; roleSet?: string[] }): Segment {
  counter += 1;
  return {
    id: `seg_c${counter}`, sourceId: "src_git", sourceKind: "github", kind: "commit", ts: over.ts, authorId: over.authorId ?? "p-1",
    thread: "commits", position: 0, text: over.text, textHash: "x", roleSet: over.roleSet ?? ["president", "tech_lead"], version: 1,
    meta: { sha: `${counter}`.padStart(40, "a"), files: over.files },
  };
}

function event(over: { id: string; start: string; summary: string; rrule?: string; repeats?: string; occurrences?: string[]; roleSet?: string[] }): Segment {
  const repeats = over.repeats ?? "no";
  return {
    id: over.id, sourceId: "src_cal", sourceKind: "ics", kind: "event", ts: over.start, authorId: null, thread: "Club calendar", position: 0,
    text: `Event: ${over.summary} | when: ${over.start.slice(0, 10)} | where: not set | repeats: ${repeats}`, textHash: "x",
    roleSet: over.roleSet ?? ["president", "tech_lead"], version: 1,
    meta: { summary: over.summary, start: over.start, rrule: over.rrule ?? null, repeats, recurring: Boolean(over.rrule), occurrences: over.occurrences ?? [], calendar: "Club calendar" },
  };
}

describe("T-U-6: parseWorkflow", () => {
  it("reads triggers, the job, steps in file order and secret names from the fixture", () => {
    const text = fs.readFileSync(path.join(FIX, "github", "files", ".github", "workflows", "deploy.yml"), "utf8");
    const doc = parseWorkflow(text);
    expect(doc.name).toBe("deploy");
    expect(doc.triggers.map((t) => t.summary)).toEqual(["a schedule (cron 0 18 * * 1)"]);
    expect(doc.jobs.map((j) => j.id)).toEqual(["deploy"]);
    expect(doc.jobs[0].steps.map((s) => s.run)).toEqual(["./firmware/deploy.sh"]);
    expect(doc.secrets.map((s) => s.name)).toEqual(["DEPLOY_SSH_KEY"]);
  });

  it("reads the matrix, uses steps, working directories and push branches from the demo workflow", () => {
    const text = fs.readFileSync(path.join(process.cwd(), CLUB_DEMO_DIR, "github", "files", ".github", "workflows", "deploy.yml"), "utf8");
    const doc = parseWorkflow(text);
    expect(doc.triggers.map((t) => t.summary)).toEqual(["a push to main"]);
    expect(doc.matrix.map((m) => m.values)).toEqual([["bench", "competition"]]);
    expect(doc.jobs[0].steps.map((s) => s.run ?? s.uses)).toEqual([
      "actions/checkout@v4", "actions/cache@v4", "pip install platformio", "pio test -e native", "pio run -e esp32dev",
      "softprops/action-gh-release@v2",
    ]);
    expect(doc.jobs[0].steps[3].display).toBe("pio test -e native (in firmware)");
    expect(doc.secrets.map((s) => s.name)).toEqual(["OTA_PASSWORD"]);
  });

  it("names, multi-line run blocks and inline triggers", () => {
    const doc = parseWorkflow([
      "on: [push, workflow_dispatch]",
      "jobs:",
      "  a:",
      "    steps:",
      "      - name: Build it",
      "        run: |",
      "          make clean",
      "          make all",
      "      - name: Ship",
      "        uses: org/ship@v1",
    ].join("\n"));
    expect(doc.triggers.map((t) => t.summary)).toEqual(["a push", "a manual start"]);
    expect(doc.jobs[0].steps.map((s) => s.display)).toEqual(["Build it: make clean; make all", "Ship: uses org/ship@v1"]);
    expect(doc.lines[doc.jobs[0].steps[0].line].trim()).toBe("make clean");
  });

  it("a file that is not a workflow gives no steps and no trace", () => {
    expect(parseWorkflow("just: text\n: : broken [").jobs).toEqual([]);
  });
});

describe("T-U-7: every quoted step is an exact quote of its cited segment", () => {
  it("holds for the workflow trace of the demo, which names the secret and never a value", () => {
    const [trace] = workflowTraces(demoSegments.filter((s) => s.kind === "file"), ENTITIES);
    expect(trace.entityKey).toBe("firmware-deploy");
    expect(trace.title).toBe("Rebuilt from .github/workflows/deploy.yml");
    expect(trace.steps.map((s) => s.text)).toEqual([
      "Runs on a push to main",
      "Runs once for each of: bench, competition",
      "uses actions/checkout@v4",
      "uses actions/cache@v4",
      "pip install platformio",
      "pio test -e native (in firmware)",
      "pio run -e esp32dev (in firmware)",
      "uses softprops/action-gh-release@v2",
      "Needs these secrets by name: OTA_PASSWORD",
    ]);
    expect(trace.steps.every((s) => s.kind === "quoted")).toBe(true);
    expectQuotesExact(trace, byId);
  });

  it("holds for every trace read from the demo, and masked placeholders pass through", () => {
    const traces = readTraces(demoSegments, ENTITIES, demo.people, { today: TODAY, thresholds: THRESHOLDS });
    expect(traces.length).toBeGreaterThan(3);
    for (const t of traces) expectQuotesExact(t, byId);
    const masked: Segment = {
      ...demoSegments.find((s) => s.kind === "file")!, id: "seg_masked", thread: ".github/workflows/x.yml",
      text: "jobs:\n  a:\n    steps:\n      - run: curl -H [SECRET:token] https://example.test\n        env:\n          K: ${{ secrets.API_KEY }}",
      meta: { path: ".github/workflows/x.yml" },
    };
    const [t] = workflowTraces([masked], ENTITIES);
    expect(t.steps[0].text).toContain("[SECRET:token]");
    expect(t.steps[1].text).toBe("Needs these secrets by name: API_KEY");
    expectQuotesExact(t, new Map([[masked.id, masked]]));
  });
});

describe("the CI run history", () => {
  const files = demoSegments.filter((s) => s.kind === "file");
  const runs = demoSegments.filter((s) => s.kind === "run");

  it("the adapter stores one run segment per run, none of them read by extraction", () => {
    expect(runs.length).toBe(34);
    expect(runs[0].text.split("\n")[0]).toMatch(/^CI run \d+ \(attempt \d+\) of firmware-deploy: (success|failure)$/);
  });

  it("finds the last green run, the failing streak, the failing step in the workflow and what did not run", () => {
    const [t] = runHistoryTraces(runs, files, ENTITIES);
    expect(t.kind).toBe("run_history");
    expect(t.entityKey).toBe("firmware-deploy");
    expect(t.attribute).toBe("status");
    expect(t.steps[0].text).toMatch(/^Last green run: run 30 on 3 Nov 2026, commit 64986c4$/);
    expect(t.steps.filter((s) => /failed at "pio test -e native"/.test(s.text))).toHaveLength(4);
    expect(t.steps.some((s) => s.text === "In .github/workflows/deploy.yml this is step 4 of 6: pio test -e native (in firmware)")).toBe(true);
    expect(t.steps.some((s) => s.kind === "derived" && s.text === "The steps after it did not run in those runs: pio run -e esp32dev, softprops/action-gh-release@v2")).toBe(true);
    expect(t.value).toContain("the last 4 runs of firmware-deploy failed at \"pio test -e native\"");
    expect(t.value).toContain("Last green run: 30 on 3 Nov 2026 (commit 64986c4)");
    expectQuotesExact(t, byId);
  });

  it("a history that ends green says so", () => {
    const green = runs.filter((r) => Number(r.meta.runNumber) <= 30);
    const [t] = runHistoryTraces(green, files, ENTITIES);
    expect(t.value).toMatch(/^Passing: run 30 of firmware-deploy on 3 Nov 2026/);
    expect(t.steps.some((s) => /failed/.test(s.text))).toBe(false);
  });
});

describe("T-U-8: commit sequence", () => {
  const entity = { key: "website-registration", label: "Website registration form", aliases: ["registration form", "register.html"] };
  const people = [{ id: "p-1", displayName: "Asha Rao", emailHmac: null, aliases: [] }];

  it("orders commits oldest first and keeps the newest eight", () => {
    const commits = Array.from({ length: 10 }, (_, i) =>
      commit({ ts: `2026-10-${String(i + 1).padStart(2, "0")}T10:00:00+05:30`, text: `register: change ${i + 1}`, files: ["website/register.html"] }));
    const t = commitSequenceTrace([...commits].reverse(), entity, people)!;
    const quoted = t.steps.filter((s) => s.kind === "quoted");
    expect(quoted).toHaveLength(8);
    expect(quoted[0].text).toBe("3 Oct 2026 Asha Rao: register: change 3 (website/register.html)");
    expect(quoted[7].text).toContain("register: change 10");
    expect(t.title).toBe("Rebuilt from 8 commits to website/register.html");
    expect(t.attribute).toBe("procedure");
  });

  it("the co-change step needs two occasions", () => {
    const once = [
      commit({ ts: "2026-10-01T10:00:00+05:30", text: "register form", files: ["website/register.html", "website/register.js"] }),
      commit({ ts: "2026-10-09T10:00:00+05:30", text: "register form copy", files: ["website/register.html"] }),
    ];
    expect(commitSequenceTrace(once, entity, people)!.steps.some((s) => /changed together/.test(s.text))).toBe(false);
    const twice = [
      ...once,
      commit({ ts: "2026-10-20T10:00:00+05:30", text: "registration form fields", files: ["website/register.js"] }),
      commit({ ts: "2026-10-21T09:00:00+05:30", text: "register form layout", files: ["website/register.html"] }),
    ];
    const t = commitSequenceTrace(twice, entity, people)!;
    const step = t.steps.find((s) => /changed together/.test(s.text))!;
    expect(step.text).toBe("website/register.html and website/register.js were changed together 2 times");
    expect(step.kind).toBe("derived");
    expect(step.citations.every((c) => c.quote === null)).toBe(true);
  });

  it("the unfinished step fires on a WIP message and not on a normal one", () => {
    const base = [
      commit({ ts: "2026-10-01T10:00:00+05:30", text: "register form: first cut", files: ["website/register.html"] }),
      commit({ ts: "2026-10-05T10:00:00+05:30", text: "register form: validation", files: ["website/register.html"] }),
    ];
    expect(commitSequenceTrace(base, entity, people)!.steps.some((s) => /left unfinished/.test(s.text))).toBe(false);
    const wip = [...base, commit({ ts: "2026-10-09T10:00:00+05:30", text: "WIP confirmation email template, not wired yet", files: ["website/register.html"] })];
    const t = commitSequenceTrace(wip, entity, people)!;
    const last = t.steps[t.steps.length - 1];
    expect(last.text).toBe("The last change on this path was left unfinished: WIP confirmation email template, not wired yet");
    expect(last.kind).toBe("quoted");
    expect(t.value).toBe("Left unfinished: WIP confirmation email template, not wired yet (the last of 3 changes to website/register.html)");
  });

  it("one commit is not a sequence, and commits about other things are left out", () => {
    const one = [commit({ ts: "2026-10-01T10:00:00+05:30", text: "register form", files: ["website/register.html"] }),
      commit({ ts: "2026-10-02T10:00:00+05:30", text: "firmware: tune", files: ["firmware/main.c"] })];
    expect(commitSequenceTrace(one, entity, people)).toBeNull();
  });

  it("finds the planted sequences in the demo", () => {
    const commits = demoSegments.filter((s) => s.kind === "commit");
    const web = commitSequenceTrace(commits, ENTITIES.find((e) => e.key === "website-registration")!, demo.people)!;
    expect(web.steps[web.steps.length - 1].text).toMatch(/left unfinished: website: WIP confirmation email template, not wired yet/);
    const dns = commitSequenceTrace(commits, ENTITIES.find((e) => e.key === "domain-dns")!, demo.people)!;
    expect(dns.steps.map((s) => s.text).join("\n")).toMatch(/TTL/);
    expectQuotesExact(web, byId);
    expectQuotesExact(dns, byId);
  });
});

describe("T-U-9: calendar", () => {
  it("a recurring event gives the cadence and the next date after today", () => {
    const yearly = event({
      id: "ev_y", start: "2026-12-02T00:00:00+05:30", summary: "Renew the domain at NameHarbor", rrule: "FREQ=YEARLY",
      repeats: "every year on 2 December", occurrences: ["2026-12-02T00:00:00+05:30", "2027-12-02T00:00:00+05:30"],
    });
    const [t] = calendarTraces([yearly], ENTITIES, THRESHOLDS, TODAY);
    expect(t.entityKey).toBe("domain-dns");
    expect(t.steps.map((s) => `${s.kind}: ${s.text}`)).toEqual(["quoted: Repeats every year on 2 December", "quoted: Next: 2026-12-02"]);
    expect(t.value).toBe("every year on 2 December; next 2026-12-02");
    expectQuotesExact(t, new Map([[yearly.id, yearly]]));
  });

  it("a next date that is not written in the event is worked out, not quoted", () => {
    const weekly = event({
      id: "ev_w", start: "2026-06-13T10:00:00+05:30", summary: "Saturday build session", rrule: "FREQ=WEEKLY",
      repeats: "every week on Saturday", occurrences: ["2026-11-14T10:00:00+05:30"],
    });
    const [t] = calendarTraces([weekly], ENTITIES, THRESHOLDS, TODAY);
    expect(t.steps[1]).toMatchObject({ kind: "derived", text: "Next: 2026-11-14" });
    expect(t.steps[1].citations[0].quote).toBeNull();
  });

  it("three one-off events in two weeks or more give a cadence; two do not", () => {
    const three = [
      event({ id: "b1", start: "2026-06-08T00:00:00+05:30", summary: "Book Workshop Lab 3 for the summer term (lab booking form)" }),
      event({ id: "b2", start: "2026-07-27T00:00:00+05:30", summary: "Book Workshop Lab 3 for the odd semester (lab booking form)" }),
      event({ id: "b3", start: "2026-10-12T00:00:00+05:30", summary: "Book Workshop Lab 3 for the Diwali block (lab booking form)" }),
    ];
    const [t] = calendarTraces(three, ENTITIES, THRESHOLDS, TODAY);
    expect(t.entityKey).toBe("lab-booking");
    expect(t.steps).toHaveLength(4);
    expect(t.steps[3]).toMatchObject({ kind: "derived", text: "Happened 3 times, 7 and 11 weeks apart" });
    expect(t.value).toBe("Happened 3 times, 7 and 11 weeks apart");
    expect(t.impliedNext).toBe("2026-12-14");
    expect(calendarTraces(three.slice(0, 2), ENTITIES, THRESHOLDS, TODAY)).toEqual([]);
  });
});

describe("T-U-10: role sets never mix", () => {
  it("segments with different role sets never end up in one trace", () => {
    const open = ["president", "tech_lead", "new_member"];
    const closed = ["president"];
    const commits = [
      commit({ ts: "2026-10-01T10:00:00+05:30", text: "dns: lower the TTL", files: ["dns/zone"], roleSet: open }),
      commit({ ts: "2026-10-02T10:00:00+05:30", text: "dns: add record", files: ["dns/zone"], roleSet: open }),
      commit({ ts: "2026-10-03T10:00:00+05:30", text: "dns: private note one", files: ["dns/zone"], roleSet: closed }),
      commit({ ts: "2026-10-04T10:00:00+05:30", text: "dns: private note two", files: ["dns/zone"], roleSet: closed }),
    ];
    const traces = readTraces(commits, ENTITIES, [], { today: TODAY, thresholds: THRESHOLDS });
    expect(traces).toHaveLength(2);
    const segs = new Map(commits.map((c) => [c.id, c]));
    for (const t of traces) {
      const sets = new Set(t.steps.flatMap((s) => s.citations).map((c) => segs.get(c.segmentId)!.roleSet.join(",")));
      expect(sets.size).toBe(1);
      expect([...sets][0]).toBe(t.roleSet.join(","));
    }
  });

  it("the Tether fixtures give a workflow trace with its secret by name", () => {
    const segments = ingestFixtures().sources.flatMap((s) => s.result.segments);
    const traces = readTraces(segments, [{ key: "firmware-deploy", label: "Firmware deploy", aliases: ["deploy", "firmware"] }], [], { today: TODAY, thresholds: THRESHOLDS });
    const wf = traces.find((t) => t.kind === "workflow")!;
    expect(wf.steps.map((s) => s.text)).toEqual([
      "Runs on a schedule (cron 0 18 * * 1)", "./firmware/deploy.sh", "Needs these secrets by name: DEPLOY_SSH_KEY",
    ]);
  });
});
