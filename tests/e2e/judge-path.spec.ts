// The five-minute judge path from docs/JUDGE_GUIDE.md, end to end in a real browser.
// Opens a fresh private copy of the demo, so it can run against the live app as often as needed:
//   E2E_BASE_URL=https://understudy-lyart.vercel.app pnpm test:e2e
import { expect, test, type Page } from "@playwright/test";

const SCORES = /B \d+ · C \d+% · K (\d+%|n\/a)/;
const RELEASE = /Released with (no|\d+) open blocking gaps?/;
const STUB = /\d+ restricted items?\. Ask the approver \(Club President\)\./;
const PLANNED = /^\W*Planned$/; // the chip reads "✓ Planned"

/** Switch "Viewing as" in the header and wait until the server has stored the new role. */
async function viewAs(page: Page, label: string) {
  const select = page.locator("header select");
  if ((await select.locator("option:checked").textContent()) === label) return;
  await select.selectOption({ label });
  // The select is controlled by the server's role: it shows the new label once the switch is stored.
  await expect(select.locator("option:checked")).toHaveText(label, { timeout: 30_000 });
  await expect(page.getByText("Switching…")).toHaveCount(0);
}

/** A plausible leaver answer for the demo's top gap questions; anything else gets a generic reply. */
function answerFor(question: string): string {
  if (/OTA|password|credential/i.test(question)) {
    return "Arjun holds the OTA password now. I gave it to him in person on 10 Nov and he keeps it in the club password vault.";
  }
  if (/lab|Pawar|booking/i.test(question)) {
    return "The next-term lab booking request must reach Mr. Pawar by 1 Dec. Kabir is right; 5 Dec was last year's date.";
  }
  if (/launch|pending|confirmation/i.test(question)) {
    return "The one step left before launch is sending the registration confirmation email from the club account.";
  }
  return "Arjun owns this from now on. The steps are in docs/DEPLOY.md and he has done them once with me.";
}

test("judge path: demo, claims, test, ask, review, handover, leak check", async ({ page }) => {
  let ws = "";

  await test.step("open the demo and wait for the pipeline", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open the robotics-club demo" }).click();
    await page.waitForURL(/\/w\/[0-9a-f-]{36}\/connect/, { timeout: 90_000 });
    ws = /\/w\/([0-9a-f-]{36})\//.exec(page.url())![1];

    // The demo replays precomputed model answers (seconds); allow minutes in case the cache is cold.
    await expect(page.getByText("Run finished. Open Reconstruct to see the claims.")).toBeVisible({ timeout: 300_000 });
    await expect(page.getByText(/The run finished with errors/)).toHaveCount(0);

    // The header stepper catches up without a reload.
    const stepper = page.getByRole("navigation", { name: "Handover steps" });
    const step = (label: string) => stepper.getByRole("listitem").filter({ hasText: label });
    await expect(step("Reconstruct")).toContainText("Done");
    await expect(step("Test")).toContainText("Done");
    await expect(stepper).not.toContainText("Next: Reconstruct");
  });

  await test.step("Claims: a citation opens its source with the quote highlighted", async () => {
    await page.goto(`/w/${ws}/claims?trust=from_record`);
    await expect(page.getByText(/^[1-9]\d* of \d+ claims visible to Club President$/)).toBeVisible();
    await page.getByRole("list", { name: "Citations" }).first().getByRole("link").first().click();
    await page.waitForURL(/\/source\//);
    const quote = page.locator("mark#quote");
    await expect(quote).toBeVisible();
    await expect(quote).not.toBeEmpty();
    await expect(page.getByText("The highlighted text below is the exact quote this claim relies on.")).toBeVisible();
  });

  await test.step("Test: scores read B · C · K", async () => {
    await page.goto(`/w/${ws}/test`);
    await expect(page.getByRole("navigation", { name: "Role being tested" })).toContainText("Incoming tech lead");
    await expect(page.getByRole("region", { name: "Scores" })).toContainText(SCORES);
  });

  await test.step("Ask as Priya: answer one question and see the re-test", async () => {
    await page.goto(`/w/${ws}/ask`);
    await viewAs(page, "Priya (outgoing tech lead)");
    await expect(page.getByRole("heading", { name: /^Open questions \([1-9]\d*\)$/ })).toBeVisible();

    const first = page.locator("ol > li", { has: page.getByRole("button", { name: "Save answer" }) }).first();
    const question = (await first.locator("p").first().textContent()) ?? "";
    await first.getByLabel("Your answer").fill(answerFor(question));
    await first.getByRole("button", { name: "Save answer" }).click();

    // Saving re-tests the successor with the stand-in model: about 10 to 20 s on the live app.
    const retest = page.getByText(/^Re-test after this answer:/).first();
    await expect(retest).toBeVisible({ timeout: 120_000 });
    await expect(retest).toContainText("→");
    await expect(page.getByRole("heading", { name: /^Answered \(1\)$/ })).toBeVisible();
  });

  await test.step("Review as Club President: approve tier A, plan the gaps, approve the snapshot", async () => {
    await page.goto(`/w/${ws}/review`);
    await viewAs(page, "Club President");

    const start = page.getByRole("region", { name: "Where to start" });
    await start.getByRole("button", { name: /^Approve \d+ tier A claims?$/ }).click();
    await expect(start.getByRole("button", { name: /tier A/ })).toHaveCount(0, { timeout: 60_000 });

    const cards = page.locator('section[aria-labelledby="plan-h"] li');
    const n = await cards.count();
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      if (await card.getByText(PLANNED).count()) continue;
      await card.getByLabel("Owner").fill("Arjun Mehta");
      await card.getByLabel("Due date").fill("2026-11-30");
      await card.getByLabel("Risk note").fill("Deploys wait until Arjun has done one with a mentor.");
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

  await test.step("Handover as Incoming tech lead: I-PASS sections and the release label", async () => {
    await page.goto(`/w/${ws}/handover`);
    await viewAs(page, "Incoming tech lead");
    await expect(page.getByRole("heading", { name: "Handover for Incoming tech lead" })).toBeVisible();
    const release = page.locator("#release-h");
    await expect(release).toHaveCount(1); // streamed content has settled: one banner, the new role's
    await expect(release).toContainText(RELEASE);
    await expect(release).not.toContainText(/complete/i);
    for (const title of [
      "Workstream status",
      "Project summary",
      "Action list",
      "Situation awareness and contingency",
      "Synthesis by receiver",
    ]) {
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }
  });

  await test.step("Handover as New member: restricted stub, no canary token", async () => {
    await viewAs(page, "New member");
    await expect(page.getByRole("heading", { name: "Handover for New member" })).toBeVisible();
    await expect(page.getByText(STUB).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("CANARY-", { useInnerText: true });
  });

  await test.step("Leak check: every role and surface passes", async () => {
    const leak = page.locator('section[aria-labelledby="leak-h"]');
    // While the page streams in, React holds the arriving section in a hidden container for a
    // moment: wait until there is exactly one.
    await expect(leak).toHaveCount(1, { timeout: 60_000 });
    await expect(leak).toBeVisible({ timeout: 60_000 });
    await expect(leak.getByText(/All \d+ checks pass$/)).toBeVisible();
    await expect(leak).not.toContainText(/\d+ leaks?/);
  });
});
