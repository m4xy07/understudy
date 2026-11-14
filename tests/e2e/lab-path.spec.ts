// The judge path on the SECOND setting (a university research group), end to end in a real browser.
// Parallel to judge-path.spec.ts: the same seven steps, with the roles, checklists, read-back items
// and canary tokens of packs/lab.json. Opens a fresh private copy of the research-group demo:
//   E2E_BASE_URL=https://understudy-lyart.vercel.app pnpm test:e2e lab-path
import { expect, test, type Page } from "@playwright/test";

const SCORES = /B \d+ · C \d+% · K (\d+%|n\/a)/;
const RELEASE = /Released with (no|\d+) open blocking gaps?/;
const STUB = /\d+ restricted items?\. Ask the approver \(Principal investigator\)\./;
const PLANNED = /^\W*Planned$/; // the chip reads "✓ Planned"

const ROLES = ["Principal investigator", "Incoming postdoc", "PhD student", "Lab manager", "Farhan (outgoing postdoc)"];
const CLUB_ROLES = ["Club President", "Incoming tech lead", "New member", "Treasurer"];
const READBACK = [
  "Biosafety approval renewal date",
  "Command that restores the last known-good environment",
  "Contact at the sequencing core",
  "Date the manuscript revision is due",
  "Day the lab meeting is held each week",
];
/**
 * Review tier B by responsibility: the button is off until the group's list was opened, then one
 * click approves the group and it leaves the list (the successor is re-tested once).
 */
async function approveGroup(page: Page, title: RegExp) {
  const group = page.getByTestId("tier-b-group").filter({ hasText: title });
  await expect(group).toHaveCount(1);
  const button = group.getByRole("button", { name: /^Approve these \d+ claims?$/ });
  await expect(button).toBeDisabled();
  await group.locator("summary").click();
  await expect(group.getByRole("link", { name: "Open evidence" }).first()).toBeVisible();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(group).toHaveCount(0, { timeout: 120_000 });
}

/** A plausible leaver answer for the demo's top gap questions; anything else gets a generic reply. */
function answerFor(question: string): string {
  if (/sequencing run|sample sheet|checksum|manifest/i.test(question)) {
    return "The six excluded samples came from run SR-0391. The sample sheet for that run and the checksum manifest MANIFEST.sha256 are in /project/bio-142/raw_v3.";
  }
  if (/freezer/i.test(question)) {
    return "The freezer check is every Monday morning. The next one is Monday 16 Nov 2026; Gauri keeps the rota.";
  }
  if (/credential|token|login|key/i.test(question)) {
    return "Gauri holds it in the lab password manager. I showed her on 6 Nov. Ask her, never post it in a channel.";
  }
  return "Gauri knows this one. I walked her through it on 6 Nov and the steps are in docs/RUNBOOK.md.";
}

/** Switch "Viewing as" in the header and wait until the server has stored the new role. */
async function viewAs(page: Page, label: string) {
  const select = page.locator("header select");
  if ((await select.locator("option:checked").textContent()) === label) return;
  await select.selectOption({ label });
  await expect(select.locator("option:checked")).toHaveText(label, { timeout: 30_000 });
  await expect(page.getByText("Switching…")).toHaveCount(0);
}

test("lab path: research-group demo, claims, test, ask, review, handover, read-back, leak check", async ({ page }) => {
  let ws = "";

  await test.step("landing: two demo cards, no sign-up, roles from the top bar", async () => {
    await page.goto("/");
    const demos = page.getByRole("list", { name: /Try a demo/ });
    await expect(demos.getByRole("listitem")).toHaveCount(2);
    await expect(demos.getByRole("heading", { name: "College robotics club" })).toBeVisible();
    await expect(demos.getByRole("heading", { name: "University research group" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open the robotics-club demo" })).toBeVisible();
    await expect(page.getByText(/No sign-up needed/)).toBeVisible();
    await expect(page.getByText(/Switch roles any time with .Viewing as. in the top bar/)).toBeVisible();
  });

  await test.step("open the research-group demo and wait for the pipeline", async () => {
    await page.getByRole("button", { name: "Open the research-group demo" }).click();
    await page.waitForURL(/\/w\/[0-9a-f-]{36}\/connect/, { timeout: 90_000 });
    ws = /\/w\/([0-9a-f-]{36})\//.exec(page.url())![1];
    await expect(page.getByRole("banner")).toContainText("University research group (demo)");

    // The demo replays precomputed model answers (seconds); allow minutes in case the cache is cold.
    await expect(page.getByText("Run finished. Open Reconstruct to see the claims.")).toBeVisible({ timeout: 300_000 });
    await expect(page.getByText(/The run finished with errors/)).toHaveCount(0);

    const stepper = page.getByRole("navigation", { name: "Handover steps" });
    const step = (label: string) => stepper.getByRole("listitem").filter({ hasText: label });
    await expect(step("Reconstruct")).toContainText("Done");
    await expect(step("Test")).toContainText("Done");
  });

  await test.step("role switcher: the five lab roles and none of the club's", async () => {
    const options = page.locator("header select option");
    await expect(options).toHaveText(ROLES);
    for (const club of CLUB_ROLES) await expect(page.locator("header select")).not.toContainText(club);
    await expect(page.locator("header select option:checked")).toHaveText("Principal investigator");
  });

  await test.step("Claims: a citation opens its source with the quote highlighted", async () => {
    await page.goto(`/w/${ws}/claims?trust=from_record`);
    await expect(page.getByText(/^[1-9]\d* of \d+ claims visible to Principal investigator$/)).toBeVisible();
    await page.getByRole("list", { name: "Citations" }).first().getByRole("link").first().click();
    await page.waitForURL(/\/source\//);
    const quote = page.locator("mark#quote");
    await expect(quote).toBeVisible();
    await expect(quote).not.toBeEmpty();
  });

  await test.step("Evaluation: scored against the lab answer key (76 planted facts)", async () => {
    await page.goto(`/w/${ws}/evaluation`);
    await expect(page.getByRole("heading", { name: "How good are the claims?" })).toBeVisible();
    await expect(page.locator("main")).toContainText("76 facts, 4 supersessions, 3 conflicts");
    await expect(page.getByRole("region", { name: "Headline metrics" })).toBeVisible();
  });

  await test.step("Test: the incoming postdoc is tested; scores read B · C · K; lab checklists", async () => {
    await page.goto(`/w/${ws}/test`);
    const tested = page.getByRole("navigation", { name: "Role being tested" });
    await expect(tested).toContainText("Incoming postdoc");
    await expect(tested).toContainText("PhD student");
    await expect(page.getByRole("region", { name: "Scores" })).toContainText(SCORES);
    // Checks that only the lab pack defines.
    await expect(page.locator("main")).toContainText("Dataset provenance");
    await expect(page.locator("main")).toContainText("Environment pin and rollback");
    await expect(page.locator("main")).not.toContainText("Club President");
  });

  await test.step("Ask as Farhan: answer one question and see the re-test", async () => {
    await page.goto(`/w/${ws}/ask`);
    await viewAs(page, "Farhan (outgoing postdoc)");
    await expect(page.getByRole("heading", { name: /^Open questions \([1-9]\d*\)$/ })).toBeVisible();

    const first = page.locator("ol > li", { has: page.getByRole("button", { name: "Save answer" }) }).first();
    const question = (await first.locator("p").first().textContent()) ?? "";
    await first.getByLabel("Your answer").fill(answerFor(question));
    await first.getByRole("button", { name: "Save answer" }).click();

    const retest = page.getByText(/^Re-test after this answer:/).first();
    await expect(retest).toBeVisible({ timeout: 120_000 });
    await expect(retest).toContainText("→");
    await expect(page.getByRole("heading", { name: /^Answered \(1\)$/ })).toBeVisible();
  });

  await test.step("Review: the leaver is refused; the PI approves tier A, plans the gaps, approves the snapshot", async () => {
    await page.goto(`/w/${ws}/review`);
    await expect(page.locator("main")).toContainText("Review and approval belong to Principal investigator");
    await viewAs(page, "Principal investigator");

    const start = page.getByRole("region", { name: "Where to start" });
    await start.getByRole("button", { name: /^Approve \d+ tier A claims?$/ }).click();
    await expect(start.getByRole("button", { name: /tier A/ })).toHaveCount(0, { timeout: 60_000 });

    // Tier B by responsibility, for the groups that feed the read-back (the restore command, the lab meeting day).
    await expect(page.getByRole("heading", { name: "Tier B by responsibility" })).toBeVisible();
    for (const title of [/R01 Nightly QC and assembly pipeline/, /R02 Manuscript revision analysis/, /Other: Weekly lab meeting/]) {
      await approveGroup(page, title);
    }

    const cards = page.locator('section[aria-labelledby="plan-h"] li');
    const n = await cards.count();
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      if (await card.getByText(PLANNED).count()) continue;
      await card.getByLabel("Owner").fill("Nisha Iyer");
      await card.getByLabel("Due date").fill("2026-11-30");
      await card.getByLabel("Risk note").fill("Nisha shadows the next run with the lab manager before taking it alone.");
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText(PLANNED)).toBeVisible({ timeout: 30_000 });
    }

    const snap = page.locator('section[aria-labelledby="snap-h"]');
    const approve = snap.getByRole("button", { name: "Approve snapshot v1" });
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(snap.locator("table")).toContainText("v1", { timeout: 60_000 });
    await expect(snap.locator("table")).toContainText(RELEASE);
  });

  await test.step("Handover as Incoming postdoc: I-PASS sections, release label, lab read-back items", async () => {
    await page.goto(`/w/${ws}/handover`);
    await viewAs(page, "Incoming postdoc");
    await expect(page.getByRole("heading", { name: "Handover for Incoming postdoc" })).toBeVisible();
    const release = page.locator("#release-h");
    await expect(release).toContainText(RELEASE);
    await expect(release).not.toContainText(/complete/i);
    await expect(page.locator("main")).toContainText("Approved by Principal investigator");
    for (const title of [
      "Workstream status",
      "Project summary",
      "Action list",
      "Situation awareness and contingency",
      "Synthesis by receiver",
    ]) {
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }
    // Read-back asks this setting's items; a typed answer from the answer key is graded.
    for (const label of READBACK) await expect(page.getByLabel(label)).toBeVisible();
    // At least 3 of the 5 items have an approved claim behind them after the grouped approval.
    expect(await page.getByText(/No approved claim for this yet/).count()).toBeLessThanOrEqual(2);
    await page.getByLabel("Biosafety approval renewal date").fill("10 Dec 2026");
    await page.getByLabel("Day the lab meeting is held each week").fill("Thursday");
    await page.getByRole("button", { name: "Check my read-back" }).click();
    await expect(page.getByText(/Match|Mismatch|Nothing to check/).first()).toBeVisible({ timeout: 30_000 });
  });

  await test.step("Handover as PhD student: restricted stub names the PI, no canary token", async () => {
    await viewAs(page, "PhD student");
    await expect(page.getByRole("heading", { name: "Handover for PhD student" })).toBeVisible();
    await expect(page.getByText(STUB).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("CANARY-", { useInnerText: true });
    await expect(page.locator("body")).not.toContainText("Club President", { useInnerText: true });
  });

  await test.step("Leak check: the lab's six tokens and seven reworded facts, every role and surface passes", async () => {
    const leak = page.locator('section[aria-labelledby="leak-h"]');
    // While the page streams in, React holds the arriving section in a hidden container for a
    // moment: wait until there is exactly one.
    await expect(leak).toHaveCount(1, { timeout: 60_000 });
    await expect(leak).toBeVisible({ timeout: 60_000 });
    await expect(leak.getByText(/All \d+ checks pass$/)).toBeVisible();
    await expect(leak).not.toContainText(/\d+ leaks?/);
    for (const role of ROLES) await expect(leak).toContainText(role);
    // This setting has its own probe file, so both blocks are there and both pass.
    await expect(leak).toContainText("6 canary tokens and 7 reworded facts");
    await expect(leak.getByRole("heading", { name: "Exact tokens" })).toBeVisible();
    await expect(leak.getByRole("heading", { name: "Reworded facts" })).toBeVisible();
    await expect(leak.getByTestId("leak-probe")).toContainText("Pass");
    await expect(leak.getByTestId("leak-no-probes")).toHaveCount(0);
  });

  await test.step("Probe results: the lab's own measured numbers, for the PI", async () => {
    await viewAs(page, "Principal investigator");
    const leak = page.locator('section[aria-labelledby="leak-h"]');
    // While the page streams in, React holds the arriving section in a hidden container for a
    // moment: wait until there is exactly one.
    await expect(leak).toHaveCount(1, { timeout: 60_000 });
    await expect(leak.getByText(/All \d+ checks pass$/)).toBeVisible({ timeout: 60_000 });
    await leak.getByRole("link", { name: "See probe results" }).click();
    await page.waitForURL(/\/probes$/);
    await expect(page.getByRole("heading", { name: "Probe results" })).toBeVisible();
    await expect(page.getByTestId("classifier-table")).toBeVisible();
    await expect(page.getByText(/^Precision \d+%\. Recall \d+%\. \d+ messages checked\.$/)).toBeVisible();
    await expect(page.getByTestId("detector-line")).toContainText(/Key terms caught \d+\./);
    // The grid is on this page too, with the same two blocks; take the first copy while it streams.
    await expect(page.getByTestId("leak-probe").first()).toContainText("Pass");
    await expect(page.getByTestId("leak-token").first()).toContainText("Pass");
    await expect(page.locator("body")).not.toContainText("Club President", { useInnerText: true });
  });
});
