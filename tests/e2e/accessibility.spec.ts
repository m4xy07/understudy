// Accessibility of the successor's journey: Test, Ask (normal, and with "cannot be reached" switched
// on) and First weeks.
//   1. axe scans every page in the states a person meets and fails on serious or critical violations.
//   2. Two keyboard-only tests: answer a question, then record a finding, with Tab, Enter and Space.
// Run against a local server (keep `pnpm dev` or `pnpm start` running):
//   pnpm test:e2e accessibility
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

const PLANNED = /^\W*Planned$/;
const GAP = /Late-night lab access.*: Next due date/;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function viewAs(page: Page, label: string) {
  const select = page.locator("header select");
  if ((await select.locator("option:checked").textContent()) === label) return;
  await select.selectOption({ label });
  await expect(select.locator("option:checked")).toHaveText(label, { timeout: 30_000 });
  await expect(page.getByText("Switching…")).toHaveCount(0);
}

/** Fails on serious or critical axe violations and prints each one with the element that broke it. */
async function expectNoSeriousViolations(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const report = bad.map((v) =>
    `${v.impact} ${v.id}: ${v.help}\n` +
    v.nodes.slice(0, 4).map((n) => `    ${n.target.join(" ")}\n      ${(n.failureSummary ?? "").replace(/\n/g, " ")}`).join("\n"),
  ).join("\n");
  expect.soft(bad, `${where}: ${bad.length} serious or critical axe violation(s)\n${report}`).toEqual([]);
  // axe cannot always decide this one ("incomplete"); a label on a plain span was the case here.
  expect.soft(results.incomplete.filter((v) => v.id === "aria-prohibited-attr"), `${where}: aria-prohibited-attr`).toEqual([]);
}

/** Presses Tab until `target` has focus. Returns the elements focused on the way (the Tab order). */
async function tabTo(page: Page, target: Locator, max = 120): Promise<string[]> {
  await expect(target).toHaveCount(1);
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return seen;
    await page.keyboard.press("Tab");
    seen.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return "none";
      const name = el.getAttribute("aria-label") || (el as HTMLInputElement).labels?.[0]?.textContent || el.textContent || "";
      return `${el.tagName.toLowerCase()}:${name.trim().slice(0, 40)}`;
    }));
  }
  throw new Error(`Tab did not reach the target in ${max} presses. Last stops: ${seen.slice(-6).join(" | ")}`);
}

/** Changes "Viewing as" with the keyboard: Tab to the menu, then type the start of the role name. */
async function viewAsByKeyboard(page: Page, typed: string, label: string) {
  const select = page.locator("header select");
  if ((await select.locator("option:checked").textContent()) === label) return;
  await tabTo(page, select);
  await page.keyboard.type(typed);
  await expect(select.locator("option:checked")).toHaveText(label, { timeout: 30_000 });
  await expect(page.getByText("Switching…")).toHaveCount(0);
}

test.describe("accessibility of the successor's journey", () => {
  let context: BrowserContext;
  let page: Page;
  let ws = "";

  test.beforeAll(async ({ browser }) => {
    // axe needs a page from its own context (browser.newPage() is refused).
    context = await browser.newContext();
    page = await context.newPage();
  });
  test.afterAll(async () => {
    await context.close();
  });

  test("open the demo and wait for the pipeline", async () => {
    test.setTimeout(12 * 60_000);
    await page.goto("/");
    await page.getByRole("button", { name: "Open the robotics-club demo" }).click();
    await page.waitForURL(/\/w\/[0-9a-f-]{36}\/connect/, { timeout: 90_000 });
    ws = /\/w\/([0-9a-f-]{36})\//.exec(page.url())![1];
    await expect(page.getByText("Run finished. Open Reconstruct to see the claims.")).toBeVisible({ timeout: 300_000 });
  });

  test("Test page", async () => {
    await page.goto(`/w/${ws}/test`);
    await viewAs(page, "Incoming tech lead");
    await expect(page.getByRole("heading", { name: "Responsibility inventory", exact: false })).toBeVisible();
    await expectNoSeriousViolations(page, "Test, successor");
    // The other tested role reads the same markup with other notes.
    await page.getByRole("link", { name: /New member/ }).click();
    await page.waitForURL(/target=/);
    await expect(page.getByRole("heading", { name: "Responsibility inventory", exact: false })).toBeVisible();
    await expectNoSeriousViolations(page, "Test, restricted audience");
  });

  test("Test page: the score is a live region and a status carries a word as well as a symbol", async () => {
    await page.goto(`/w/${ws}/test`);
    const scores = page.getByRole("region", { name: "Scores" }).getByRole("status");
    await expect(scores).toContainText(/B \d+ blocking gaps, C \d+% coverage, K (\d+%|n\/a) backed by records/);
    // Every coverage chip reads as a word (the symbol is hidden from screen readers).
    const chips = page.locator("li span.rounded-full").filter({ hasText: /Covered|Partial|Missing|Restricted|Conflicting|Not tested/ });
    expect(await chips.count()).toBeGreaterThan(0);
    for (const chip of await chips.all()) expect(((await chip.textContent()) ?? "").replace(/[^\p{L}]/gu, "").length).toBeGreaterThan(3);
    await expect(page.locator("table caption")).toHaveText("Test runs, oldest first");
  });

  test("Ask page, normal flow, as the leaver", async () => {
    await page.goto(`/w/${ws}/ask`);
    await viewAs(page, "Priya (outgoing tech lead)");
    await expect(page.getByRole("heading", { name: /^Open questions/ })).toBeVisible();
    await expectNoSeriousViolations(page, "Ask, leaver");
  });

  test("keyboard only: answer a question on Ask", async () => {
    test.setTimeout(3 * 60_000);
    await page.goto(`/w/${ws}/ask`);
    await viewAsByKeyboard(page, "Priya", "Priya (outgoing tech lead)");
    const heading = page.getByRole("heading", { name: /^Open questions/ });
    await expect(heading).toBeVisible();
    const before = Number(/\((\d+)\)/.exec((await heading.textContent()) ?? "")![1]);

    const form = page.locator("form").filter({ has: page.getByLabel("Your answer") }).first();
    const answerBox = form.getByLabel("Your answer");
    await tabTo(page, answerBox);
    // The sample answer button comes straight after the box and works with Space.
    const sample = form.getByRole("button", { name: "Use a sample answer" });
    const toSample = await tabTo(page, sample);
    expect(toSample).toHaveLength(1); // one Tab, and the stop is the sample button itself
    await page.keyboard.press("Space");
    await expect(answerBox).not.toHaveValue("");

    // From there to Save answer, Tab only passes through this form's own controls, in order.
    const save = form.getByRole("button", { name: "Save answer" });
    const stops = await tabTo(page, save);
    expect(stops.at(-1)).toMatch(/^button:Save answer/);
    expect(stops.slice(0, -1).length).toBeGreaterThan(0);
    expect(stops.slice(0, -1).every((s) => s.startsWith("input:"))).toBe(true); // the roles it can be shown to
    await page.keyboard.press("Enter");

    // The form is gone, so focus is put on the list heading, and the new score is announced.
    await expect(page.getByRole("heading", { name: `Open questions (${before - 1})` })).toBeFocused({ timeout: 120_000 });
    const scores = page.getByRole("region", { name: "Successor scores" }).getByRole("status");
    await expect(scores).toContainText("Last answer:");
    await expect(scores).toContainText("→");
    await expect(page.getByRole("heading", { name: /^Answered \(1\)/ })).toBeVisible();
    await expectNoSeriousViolations(page, "Ask, after an answer");
  });

  test("Ask page, recovery switched on, as the approver", async () => {
    test.setTimeout(5 * 60_000);
    await viewAs(page, "Club President");
    await page.goto(`/w/${ws}/ask`);
    await expectNoSeriousViolations(page, "Ask, approver, recovery off");
    await page.getByRole("button", { name: /can't be reached$/ }).click();
    await expect(page.getByRole("heading", { name: /^Gaps being worked/ })).toBeVisible({ timeout: 180_000 });
    await expectNoSeriousViolations(page, "Ask, approver, recovery on");
    await viewAs(page, "Incoming tech lead");
    await expectNoSeriousViolations(page, "Ask, successor, recovery on");
    await viewAs(page, "Club President");
    await page.getByRole("button", { name: /is back\. Use the normal flow$/ }).click();
    await expect(page.getByRole("heading", { name: /^Open questions/ })).toBeVisible({ timeout: 180_000 });
  });

  test("approve a snapshot so First weeks has something to show", async () => {
    test.setTimeout(5 * 60_000);
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
      await card.getByLabel("Owner").fill("Arjun Rao");
      await card.getByLabel("Due date").fill("2026-11-30");
      await card.getByLabel("Risk note").fill("Open until Arjun has checked it with a mentor.");
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText(PLANNED)).toBeVisible({ timeout: 30_000 });
    }
    const snap = page.locator('section[aria-labelledby="snap-h"]');
    await snap.getByRole("button", { name: "Approve snapshot v1" }).click();
    await expect(snap.locator("table")).toContainText("First release", { timeout: 60_000 });
  });

  test("First weeks page: list and open form", async () => {
    await page.goto(`/w/${ws}/first-weeks`);
    await viewAs(page, "Incoming tech lead");
    await expect(page.getByRole("heading", { name: "First weeks", level: 1 })).toBeVisible();
    await expectNoSeriousViolations(page, "First weeks, list");

    const row = page.getByRole("list", { name: "Blocking gaps" }).getByRole("listitem").filter({ hasText: GAP });
    await row.getByRole("button", { name: "Record a finding" }).click();
    await expect(row.getByRole("heading", { name: "What did you find?" })).toBeFocused();
    await expectNoSeriousViolations(page, "First weeks, form open");
    await row.getByRole("button", { name: "Cancel" }).click();
  });

  test("keyboard only: record a finding on First weeks", async () => {
    test.setTimeout(3 * 60_000);
    await page.goto(`/w/${ws}/first-weeks`);
    await viewAsByKeyboard(page, "Incoming", "Incoming tech lead");
    const blocking = page.getByRole("list", { name: "Blocking gaps" }).getByRole("listitem");

    // Cancel with the keyboard puts focus back on the button that opened the form.
    // (a gap restricted for this role has no button, so pick one that has it)
    const candidate = blocking.filter({ hasNotText: GAP }).filter({ has: page.getByRole("button", { name: "Record a finding" }) }).first();
    // Pin the row by its title: once its form opens the button is gone and the filter above would move on.
    const title = ((await candidate.locator("p").first().textContent()) ?? "").trim();
    const other = blocking.filter({ hasText: title });
    const otherOpen = other.getByRole("button", { name: "Record a finding" });
    await tabTo(page, otherOpen);
    await page.keyboard.press("Space");
    await expect(other.getByRole("heading", { name: "What did you find?" })).toBeFocused();
    await tabTo(page, other.getByRole("button", { name: "Cancel" }));
    await page.keyboard.press("Enter");
    await expect(otherOpen).toBeFocused();

    // The example gap: open with Space, fill with the example, save with Enter.
    const row = blocking.filter({ hasText: GAP });
    await tabTo(page, row.getByRole("button", { name: "Record a finding" }));
    await page.keyboard.press("Space");
    const heading = row.getByRole("heading", { name: "What did you find?" });
    await expect(heading).toBeFocused();
    // The first stop inside the form is the example button; Enter fills the form.
    await page.keyboard.press("Tab");
    await expect(row.getByRole("button", { name: "Use the example finding" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row.getByLabel("How do you know?")).not.toHaveValue("");
    const stops = await tabTo(page, row.getByRole("button", { name: "Save finding" }));
    expect(stops.at(-1)).toMatch(/^button:Save finding/);
    expect(stops.slice(0, -1).every((s) => /^(input|textarea):/.test(s))).toBe(true); // the form's own fields, in order
    await page.keyboard.press("Enter");

    const done = row.getByRole("status");
    await expect(done).toContainText('Saved as "Successor found"', { timeout: 90_000 });
    await expect(done).toBeFocused();
    await expect(page.getByRole("status", { name: "First weeks summary" })).toContainText("1 finding waiting for review");
    await expectNoSeriousViolations(page, "First weeks, finding saved");

    // The findings table has a caption and header cells, and its links say which gap they belong to.
    const table = page.locator('section[aria-labelledby="findings-h"] table');
    await expect(table.locator("caption")).toHaveCount(1);
    await expect(table.getByRole("columnheader")).toHaveCount(4);
    await expect(table.getByRole("link", { name: /^Open evidence for Late-night lab access/ })).toHaveCount(1);

    await viewAs(page, "Club President");
    await expectNoSeriousViolations(page, "First weeks, approver");
  });
});
