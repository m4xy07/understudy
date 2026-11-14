// Unreachable-leaver recovery, end to end in a real browser (Round 3, improvement 1).
// The judge path of docs/round3/specs/01_recovery.md section 3.7. Opens a fresh private copy of the
// demo, so it can run against a local server or the live app as often as needed:
//   pnpm build && MODEL_DISABLED=1 pnpm exec next start -p 3411
//   E2E_BASE_URL=http://localhost:3411 pnpm exec playwright test recovery
// With MODEL_DISABLED=1 the server replays model answers from the cache (pnpm db:seed); the sample
// answers used here are the ones the precompute step records.
import { expect, test, type Locator, type Page } from "@playwright/test";

/** Switch "Viewing as" in the header and wait until the server has stored the new role. */
async function viewAs(page: Page, label: string) {
  const select = page.locator("header select");
  if ((await select.locator("option:checked").textContent()) === label) return;
  await select.selectOption({ label });
  await expect(select.locator("option:checked")).toHaveText(label, { timeout: 30_000 });
  await expect(page.getByText("Switching…")).toHaveCount(0);
}

async function viewingAs(page: Page): Promise<string> {
  return (await page.locator("header select option:checked").textContent()) ?? "";
}

/** The two cells of one row of the before and after panel. */
async function panelRow(panel: Locator, label: string): Promise<[string, string]> {
  const row = panel.getByRole("row").filter({ has: panel.page().getByRole("rowheader", { name: label, exact: true }) });
  const cells = row.getByRole("cell");
  return [(await cells.nth(0).innerText()).trim(), (await cells.nth(1).innerText()).trim()];
}

const num = (s: string) => Number(/\d+/.exec(s)?.[0] ?? "NaN");

// A chip reads symbol then word, for example "≈Inferred".
const INFERRED = /^\W*Inferred$/;
const OPTIONS = /^\W*Ranked options$/;
const SECOND_HAND = /^\W*Second-hand$/;

test("recovery: the leaver cannot be reached, neighbours answer, traces and options show, then back to normal", async ({ page }) => {
  let ws = "";

  await test.step("open the demo and wait for the pipeline", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open the robotics-club demo" }).click();
    await page.waitForURL(/\/w\/[0-9a-f-]{36}\/connect/, { timeout: 90_000 });
    ws = /\/w\/([0-9a-f-]{36})\//.exec(page.url())![1];
    await expect(page.getByText("Run finished. Open Reconstruct to see the claims.")).toBeVisible({ timeout: 300_000 });
  });

  await test.step("switch off: only the approver sees the switch card", async () => {
    await page.goto(`/w/${ws}/ask`);
    await expect(page.getByRole("heading", { name: /^Open questions \(\d+\)$/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Can Priya answer?" })).toBeVisible();
    await viewAs(page, "Incoming tech lead");
    await expect(page.getByRole("heading", { name: "Can Priya answer?" })).toHaveCount(0);
    await viewAs(page, "Club President");
  });

  await test.step("the approver switches recovery on", async () => {
    await page.getByLabel("Why (optional, goes in the audit log)").fill("Graduated early. Phone is off.");
    await page.getByRole("button", { name: "Priya can't be reached" }).click();
    await expect(page.getByText("Switched on by Club President on")).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText("Reason: Graduated early. Phone is off.")).toBeVisible();
    await expect(page.getByRole("region", { name: "With and without the leaver" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Gaps being worked \(\d+\)$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Priya is back. Use the normal flow" })).toBeVisible();
    // the leaver's question list and answer boxes are gone
    await expect(page.getByRole("heading", { name: /^Open questions/ })).toHaveCount(0);
  });

  await test.step("each gap shows three rungs; a skipped neighbour, an Inferred trace and Ranked options are there", async () => {
    const ladder = page.getByRole("region", { name: "Gaps being worked" });
    const cards = ladder.locator("li[data-gap]");
    const n = await cards.count();
    expect(n).toBeGreaterThan(3);
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      await expect(card.getByRole("heading", { name: "1. People who worked on this" })).toBeVisible();
      await expect(card.getByRole("heading", { name: "2. What the files and history show" })).toBeVisible();
      await expect(card.getByRole("heading", { name: "3. Possible answers" })).toBeVisible();
      await expect(card.getByText(/^\W*(Closed|Partly answered|Still open)$/).first()).toBeVisible(); // symbol and word
    }
    await expect(ladder.getByText("Skipped: no access.", { exact: false }).first()).toBeVisible();
    await expect(ladder.getByText("Not asked: no role in this handover.", { exact: false }).first()).toBeVisible();
    await expect(ladder.getByText(INFERRED).first()).toBeVisible();
    await expect(ladder.getByText(OPTIONS).first()).toBeVisible();
    await expect(ladder.getByText("Files and history cannot say who. Skipped.").first()).toBeVisible();
  });

  await test.step("rebuilt procedures: the CI run history is read back with cited steps", async () => {
    const rebuilt = page.getByRole("region", { name: "Rebuilt procedures" });
    await expect(rebuilt.getByRole("heading", { name: /^Rebuilt procedures \(\d+\)$/ })).toBeVisible();
    const runs = rebuilt.locator('li[data-trace="run_history"]');
    await expect(runs.getByText("Rebuilt from the run history of .github/workflows/deploy.yml")).toBeVisible();
    await expect(runs.getByText(/Last green run: run 30 on 3 Nov 2026/)).toBeVisible();
    await expect(runs.getByText(/failed at "pio test -e native"/).first()).toBeVisible();
    await expect(runs.getByText("Quoted", { exact: true }).first()).toBeVisible();
    await expect(runs.getByText("Worked out from history", { exact: true }).first()).toBeVisible();
    await expect(runs.getByText(/\d+ of \d+ steps are quoted word for word\./)).toBeVisible();
    const workflow = rebuilt.locator('li[data-trace="workflow"]');
    await expect(workflow.getByText("Needs these secrets by name: OTA_PASSWORD")).toBeVisible();
    // a cited step opens its source segment
    await runs.getByRole("link", { name: "Open source" }).first().click();
    await page.waitForURL(/\/source\//);
    await expect(page.getByText("This segment is not visible to your role.")).toHaveCount(0);
    await expect(page.getByText(/CI run 30 \(attempt 1\) of firmware-deploy: success/)).toBeVisible();
    await page.goto(`/w/${ws}/ask`);
  });

  let closedBefore = 0;
  let partlyBefore = 0;
  let bBefore = "";
  await test.step("the before and after panel: fewer gaps close without the leaver", async () => {
    const panel = page.getByRole("region", { name: "With and without the leaver" });
    const [worked1, worked2] = await panelRow(panel, "Gaps worked");
    const [closed1, closed2] = await panelRow(panel, "Closed");
    const [, partly2] = await panelRow(panel, "Partly answered");
    const [b1, b2] = await panelRow(panel, "B");
    expect(num(worked1)).toBe(num(worked2));
    expect(num(closed2)).toBeLessThan(num(closed1));
    expect(num(b1)).toBeLessThanOrEqual(num(b2));
    await expect(panel.getByText("From the latest successor test.")).toBeVisible();
    closedBefore = num(closed2);
    partlyBefore = num(partly2);
    bBefore = b2;
  });

  await test.step("switch to a neighbour and answer with the sample: saved as Second-hand, B unchanged", async () => {
    await page.getByRole("button", { name: "Switch to Arjun to answer" }).first().click();
    await expect(page.getByRole("heading", { name: /^Questions for you \([1-9]\d*\)$/ })).toBeVisible({ timeout: 30_000 });
    expect(await viewingAs(page)).toBe("Incoming tech lead");
    const mine = page.getByRole("region", { name: "Questions for you" });
    const card = mine.locator("ol > li").filter({ has: page.getByRole("button", { name: "Use a sample answer" }) }).first();
    await expect(card.getByText(/^Why you: /)).toBeVisible();
    await card.getByRole("button", { name: "Use a sample answer" }).click();
    await expect(card.getByLabel("What you know")).toHaveValue(/Priya has it\./);
    await card.getByRole("button", { name: "Save answer" }).click();
    await expect(mine.getByText(/Saved as "Second-hand"\./)).toBeVisible({ timeout: 180_000 });
    await expect(mine.getByText(/B \d+ \(no change\) · C \d+%/)).toBeVisible();
    await expect(mine.getByText(/Arjun Rao said \(second-hand\): Priya has it\./)).toBeVisible();
  });

  await test.step("I don't know stores nothing", async () => {
    const mine = page.getByRole("region", { name: "Questions for you" });
    const left = mine.locator("ol > li");
    const before = await left.count();
    expect(before).toBeGreaterThan(0);
    await left.first().getByRole("button", { name: "I don't know" }).click();
    await expect(mine.getByText("Noted. Nothing was saved as evidence.").first()).toBeVisible({ timeout: 60_000 });
    await expect(left).toHaveCount(before - 1);
    // a refresh keeps both replies and does not offer them again
    await page.reload();
    await expect(mine.getByText(/Saved as "Second-hand"\./)).toBeVisible();
    await expect(mine.getByRole("heading", { name: /^Your replies \(2\)$/ })).toBeVisible();
  });

  await test.step("the skipped role sees nothing about being skipped", async () => {
    await viewAs(page, "Club President");
    const skipped = page.getByRole("region", { name: "Gaps being worked" }).locator('li[data-status="skipped_no_access"]').first();
    const text = await skipped.innerText();
    const role = /\(([^)]+)\)\. Skipped: no access\./.exec(text)?.[1];
    expect(role).toBeTruthy();
    await viewAs(page, role!);
    await expect(page.getByRole("heading", { name: /^Gaps being worked/ })).toBeVisible();
    await expect(page.getByText(`(${role}). Skipped: no access.`, { exact: false })).toHaveCount(0);
    await expect(page.getByText(`Only Club President can change this.`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Priya is back. Use the normal flow" })).toHaveCount(0);
  });

  await test.step("back as the approver: one more gap is partly answered, B did not move, one Second-hand claim", async () => {
    await viewAs(page, "Club President");
    const panel = page.getByRole("region", { name: "With and without the leaver" });
    const [closed1, closed2] = await panelRow(panel, "Closed");
    const [, partly2] = await panelRow(panel, "Partly answered");
    const [, b2] = await panelRow(panel, "B");
    expect(num(closed2)).toBeLessThan(num(closed1));
    expect(num(closed2) + num(partly2)).toBeGreaterThanOrEqual(closedBefore + partlyBefore);
    expect(b2).toBe(bBefore);
    await expect(panel.getByText(SECOND_HAND).first()).toBeVisible();
    const ladder = page.getByRole("region", { name: "Gaps being worked" });
    await expect(ladder.getByText("Arjun Rao answered.", { exact: false })).toBeVisible();
    await expect(ladder.getByText("could not answer.", { exact: false }).first()).toBeVisible();
    await page.goto(`/w/${ws}/claims?trust=second_hand`);
    await expect(page.getByText(/^1 of \d+ claims visible to Club President$/)).toBeVisible();
    await expect(page.getByText(/Arjun Rao said \(second-hand\)/).first()).toBeVisible();
  });

  await test.step("the leaver role sees closed answer boxes", async () => {
    await page.goto(`/w/${ws}/ask`);
    await viewAs(page, "Priya (outgoing tech lead)");
    await expect(page.getByText("You are marked as unreachable, so your answer boxes are closed.", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Your answer")).toHaveCount(0);
    await viewAs(page, "Club President");
  });

  await test.step("the approver switches back: the normal flow returns and the labelled evidence stays", async () => {
    await page.getByRole("button", { name: "Priya is back. Use the normal flow" }).click();
    await expect(page.getByRole("heading", { name: /^Open questions \(\d+\)$/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Only Priya (outgoing tech lead) answers these.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Can Priya answer?" })).toBeVisible();
    await page.goto(`/w/${ws}/claims?trust=second_hand`);
    await expect(page.getByText(/^1 of \d+ claims visible to Club President$/)).toBeVisible();
    await page.goto(`/w/${ws}/claims?trust=inferred`);
    await expect(page.getByText(/Rebuilt from the run history/).first()).toBeVisible();
  });

  await test.step("switching on again resumes the ladder and keeps what was answered", async () => {
    await page.goto(`/w/${ws}/ask`);
    await page.getByRole("button", { name: "Priya can't be reached" }).click();
    await expect(page.getByRole("heading", { name: /^Gaps being worked \(\d+\)$/ })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByRole("region", { name: "Gaps being worked" }).getByText("Arjun Rao answered.", { exact: false })).toBeVisible();
  });
});
