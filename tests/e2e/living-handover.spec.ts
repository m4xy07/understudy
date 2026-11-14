// Living handover, end to end in a real browser, on the club demo:
// snapshot v1, the successor records the example finding on First weeks, the approver approves it,
// snapshot v2 with "What changed", version history, and what each role sees.
// Run against a local production server:
//   pnpm build && PORT=45617 pnpm start      (another terminal)
//   E2E_BASE_URL=http://localhost:45617 pnpm test:e2e living-handover
import { expect, test, type Page } from "@playwright/test";

const RELEASE = /Released with (no|\d+) open blocking gaps?/;
const PLANNED = /^\W*Planned$/;
const GAP = /Late-night lab access.*: Next due date/;
const BANNER = 'section[aria-labelledby="release-h"]';
const NOTE = "Mr. Pawar confirmed late access is every Wednesday in build season. The next one is Wednesday 18 Nov. Ask him by Monday.";

async function viewAs(page: Page, label: string) {
  const select = page.locator("header select");
  if ((await select.locator("option:checked").textContent()) === label) return;
  await select.selectOption({ label });
  await expect(select.locator("option:checked")).toHaveText(label, { timeout: 30_000 });
  await expect(page.getByText("Switching…")).toHaveCount(0);
}

test("living handover: finding, review, snapshot v2, what changed, roles", async ({ page }) => {
  let ws = "";
  let b1 = -1;
  // A cold model cache makes the first pipeline run take minutes; the rest of the path is seconds.
  test.setTimeout(12 * 60_000);

  await test.step("open the demo and wait for the pipeline", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open the robotics-club demo" }).click();
    await page.waitForURL(/\/w\/[0-9a-f-]{36}\/connect/, { timeout: 90_000 });
    ws = /\/w\/([0-9a-f-]{36})\//.exec(page.url())![1];
    await expect(page.getByText("Run finished. Open Reconstruct to see the claims.")).toBeVisible({ timeout: 300_000 });
  });

  await test.step("before any snapshot: First weeks has nothing to show and no header link", async () => {
    await expect(page.locator("header").getByRole("link", { name: /First weeks/ })).toHaveCount(0);
    await page.goto(`/w/${ws}/first-weeks`);
    await expect(page.getByText("No approved handover yet.")).toBeVisible();
    await expect(page.getByText("First weeks starts after the approver approves a snapshot.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Record a finding" })).toHaveCount(0);
  });

  await test.step("as Club President: approve tier A, plan the gaps, approve snapshot v1", async () => {
    await page.goto(`/w/${ws}/review`);
    await viewAs(page, "Club President");
    await expect(page.getByRole("heading", { name: /^Successor findings/ })).toHaveCount(0); // hidden while there are none
    const start = page.getByRole("region", { name: "Where to start" });
    await start.getByRole("button", { name: /^Approve \d+ tier A claims?$/ }).click();
    await expect(start.getByRole("button", { name: /tier A/ })).toHaveCount(0, { timeout: 60_000 });

    const cards = page.locator('section[aria-labelledby="plan-h"] li');
    const n = await cards.count();
    expect(n).toBeGreaterThan(0);
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
    await expect(snap.locator("table")).toContainText(RELEASE, { timeout: 60_000 });
    await expect(snap.locator("table")).toContainText("First release");
    b1 = Number(/B (\d+)/.exec((await page.locator('section[aria-labelledby="release-h"]').innerText()))![1]);
  });

  await test.step("as Incoming tech lead: the handover points to First weeks; the open gaps are a checklist", async () => {
    await page.goto(`/w/${ws}/handover`);
    await viewAs(page, "Incoming tech lead");
    await expect(page.getByText("Some gaps are still open. Record what you find in your first weeks.")).toBeVisible();
    await expect(page.getByRole("heading", { name: /^What changed in v/ })).toHaveCount(0); // nothing to compare with yet
    await page.getByRole("link", { name: "Go to First weeks" }).click();
    await page.waitForURL(/\/first-weeks/);
    await expect(page.getByRole("heading", { name: "First weeks", level: 1 })).toBeVisible();
    await expect(page.locator("header").getByRole("link", { name: /First weeks/ })).toBeVisible();

    const blocking = page.getByRole("list", { name: "Blocking gaps" }).getByRole("listitem");
    expect(await blocking.count()).toBeGreaterThan(0);
    const row = blocking.filter({ hasText: GAP });
    await expect(row).toHaveCount(1);
    // Owner and due date come from the continuation plan.
    await expect(row).toContainText("Owner: Arjun Rao · Due: 2026-11-30 · Risk: Open until Arjun has checked it with a mentor.");
    await expect(row).toContainText("Open");
    await expect(page.getByText("No findings yet.")).toBeVisible();
    await expect(page.getByRole("status", { name: "First weeks summary" })).toContainText("0 findings waiting for review · 0 closed since v1");
  });

  await test.step("record the example finding: saved as Successor found, scores unchanged", async () => {
    const row = page.getByRole("list", { name: "Blocking gaps" }).getByRole("listitem").filter({ hasText: GAP });
    await row.getByRole("button", { name: "Record a finding" }).click();
    await expect(row.getByRole("heading", { name: "What did you find?" })).toBeVisible();

    // The form rules: a date that has passed is refused.
    await row.getByLabel("Date").fill("2026-11-04");
    await row.getByRole("button", { name: "Save finding" }).click();
    await expect(row.getByRole("alert")).toHaveText(/That date has passed\. Enter the next one\./);

    await row.getByRole("button", { name: "Use the example finding" }).click();
    await expect(row.getByLabel("Date")).toHaveValue("2026-11-18");
    await expect(row.getByLabel("How do you know?")).toHaveValue(NOTE);
    await row.getByLabel("Link (optional)").fill("https://college.example/workshop/late-access");
    await row.getByLabel("File (optional)").setInputFiles({
      name: "late-access.txt", mimeType: "text/plain",
      buffer: Buffer.from("Late access, build season: Wednesdays. Next: 18 Nov 2026. Contact lab office: lab.office@example.com\n"),
    });
    await row.getByRole("button", { name: "Save finding" }).click();
    await expect(row.getByRole("status")).toHaveText(
      /Saved as "Successor found"\. It is waiting for Club President to review\. Scores do not change until it is approved\./,
      { timeout: 60_000 },
    );
    await expect(row).toContainText("Waiting for review");
    await expect(row.getByRole("button", { name: "Record a finding" })).toHaveCount(0);

    const table = page.locator('section[aria-labelledby="findings-h"] table');
    await expect(table).toContainText("2026-11-18");
    await expect(table).toContainText(NOTE);
    await expect(table).toContainText("Waiting for review");
    await expect(table).toContainText("https://college.example/workshop/late-access (not opened by Understudy)");
    await expect(table).toContainText("File: late-access.txt");
    await expect(table.getByRole("link", { name: "https://college.example/workshop/late-access" })).toHaveCount(0); // text, never a link
    await expect(page.getByRole("status", { name: "First weeks summary" })).toContainText("1 finding waiting for review");

    // Refresh safe, and nothing has moved: still v1, same B.
    await page.reload();
    await expect(page.locator('section[aria-labelledby="findings-h"] table tbody tr')).toHaveCount(1);
    await page.goto(`/w/${ws}/handover`);
    await expect(page.locator("#release-h")).toBeVisible();
    await expect(page.locator(BANNER)).toContainText(/Snapshot\s+v1/);
    await expect(page.locator(BANNER)).toContainText(`B ${b1} ·`);
    await expect(page.getByRole("article")).not.toContainText("2026-11-18");
  });

  await test.step("the evidence opens with the answer highlighted", async () => {
    await page.goto(`/w/${ws}/first-weeks`);
    await page.locator('section[aria-labelledby="findings-h"]').getByRole("link", { name: "Open evidence" }).click();
    await page.waitForURL(/\/source\//);
    await expect(page.locator("mark#quote")).toHaveText("Answer: 2026-11-18");
  });

  await test.step("the successor cannot approve; the approver sees it under Successor findings", async () => {
    await page.goto(`/w/${ws}/review`);
    const group = page.locator("section#findings");
    await expect(group.getByRole("heading", { name: "Successor findings (1)" })).toBeVisible();
    await expect(group).toContainText("Only Club President can approve findings.");
    await expect(group.getByRole("button", { name: /Approve and release/ })).toHaveCount(0);

    await viewAs(page, "Priya (outgoing tech lead)");
    await expect(group).toContainText("The leaver can never approve.");
    await expect(group.getByRole("button", { name: /Approve and release/ })).toHaveCount(0);

    await viewAs(page, "Club President");
    const card = group.getByRole("listitem").filter({ hasText: NOTE });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Successor found");
    await expect(card).toContainText("Tier C");
    await expect(card).toContainText("Pending");
    await expect(card).toContainText(/Closes: Late-night lab access.*: Next due date · Recorded/);
    await expect(card).toContainText("Link: https://college.example/workshop/late-access (not opened by Understudy)");
    await expect(card).toContainText("File: late-access.txt");
    // The evidence: the finding as recorded, and the attached file with its contact masked.
    await expect(card.locator("mark")).toHaveText("Answer: 2026-11-18");
    await expect(card).toContainText("[CONTACT:");
    await expect(card).not.toContainText("lab.office@example.com");
    // The finding is not in the tier lists.
    await expect(page.locator("section#claims")).not.toContainText(NOTE);

    // Tier C: no decision before the evidence is opened and a reason is written.
    const approve = card.getByRole("button", { name: "Approve and release v2" });
    await expect(approve).toBeDisabled();
    await card.getByLabel("I opened the evidence").check();
    await expect(approve).toBeDisabled();
    await card.getByLabel(/Why is this right or wrong\?/).fill("Checked with Mr. Pawar on the phone.");
    await expect(approve).toBeEnabled();
  });

  await test.step("approve: re-test, snapshot v2, B one lower", async () => {
    const group = page.locator("section#findings");
    const card = group.getByRole("listitem").filter({ hasText: NOTE });
    await card.getByRole("button", { name: "Approve and release v2" }).click();
    await expect(card.getByRole("status")).toHaveText(
      new RegExp(`Finding approved\\. Snapshot v2 released\\. B ${b1} → ${b1 - 1}\\.`), { timeout: 180_000 },
    );
    await expect(card).toContainText("Approved in v2");
    await expect(group.getByRole("heading", { name: "Successor findings (0)" })).toBeVisible();
    await expect(card.getByRole("button", { name: /Approve and release/ })).toHaveCount(0);

    // Version history: v1 and v2, both verified, with the reason and the stored diff.
    const history = page.locator('section[aria-labelledby="snap-h"] table');
    const rows = history.locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("v2");
    await expect(rows.nth(0)).toContainText("verified");
    await expect(rows.nth(0)).toContainText(/Finding approved: Late-night lab access.*: Next due date/);
    await expect(rows.nth(0)).toContainText("+1 added · −0 removed · ~0 changed");
    await expect(rows.nth(1)).toContainText("v1");
    await expect(rows.nth(1)).toContainText("verified");
    await expect(rows.nth(1)).toContainText("First release");
    await rows.nth(0).getByText("Show what changed in v2").click();
    await expect(rows.nth(0)).toContainText(`Added: Incoming tech lead found: ${NOTE}`);
    await expect(rows.nth(0)).toContainText(/Gap closed: Late-night lab access.*: Next due date/);

    // A refresh does not approve it twice.
    await page.reload();
    await expect(page.locator('section[aria-labelledby="snap-h"] table tbody tr')).toHaveCount(2);
    await expect(page.locator('section[aria-labelledby="snap-h"]').getByRole("button", { name: "Approve snapshot v3" })).toBeVisible();
  });

  await test.step("handover as Incoming tech lead: v2 and the What changed panel", async () => {
    await page.goto(`/w/${ws}/handover`);
    await viewAs(page, "Incoming tech lead");
    await expect(page.locator(BANNER)).toContainText(/Snapshot\s+v2/);
    await expect(page.getByText("Hash verified")).toBeVisible();
    const panel = page.locator('section[aria-labelledby="changed-2"]');
    await expect(panel.getByRole("heading", { name: "What changed in v2" })).toBeVisible();
    await expect(panel).toContainText(/Compared with v1\. Approved .+ IST\./);
    await expect(panel).toContainText("Why: a successor finding was approved.");
    await expect(panel).toContainText(`Added: Incoming tech lead found: ${NOTE}`);
    await expect(panel).toContainText(/Gap closed: Late-night lab access.*: Next due date/);
    await expect(panel).toContainText(`B went from ${b1} to ${b1 - 1}. 1 blocking gap is now covered by a successor finding.`);
    await expect(panel).toContainText(/C went from \d+% to \d+%\. 1 more check is covered\./);
    await expect(panel).toContainText(/K (stayed at \d+%\.|went from \d+% to \d+%\. K counts only covered work that a record backs\.)/);
    await expect(panel).toContainText("This is a new version. Read back again to acknowledge v2.");
    await expect(panel).not.toContainText("restricted change");
    // The document itself now carries the date, labelled as the successor's finding.
    const doc = page.getByRole("article");
    await expect(doc).toContainText("2026-11-18");
    await expect(doc).toContainText("Successor found");
    await expect(page.locator("#release-h")).toContainText(RELEASE);
    await panel.getByRole("link", { name: "See all versions" }).click();
    await page.waitForURL(/\/review/);
  });

  await test.step("First weeks: the gap is closed in v2", async () => {
    await page.goto(`/w/${ws}/first-weeks`);
    await expect(page.getByRole("list", { name: "Blocking gaps" }).getByRole("listitem").filter({ hasText: GAP })).toHaveCount(0);
    const closed = page.getByRole("list", { name: "Closed gaps" }).getByRole("listitem").filter({ hasText: GAP });
    await expect(closed).toContainText("Closed in v2");
    await expect(page.locator('section[aria-labelledby="findings-h"] table')).toContainText("Approved in v2");
    await expect(page.getByRole("status", { name: "First weeks summary" })).toContainText("0 findings waiting for review · 1 closed since v1");
  });

  await test.step("each role's handover is v2 under the same permission rules", async () => {
    await page.goto(`/w/${ws}/handover`);
    for (const role of ["New member", "Treasurer", "Club President"]) {
      await viewAs(page, role);
      await expect(page.getByRole("heading", { name: `Handover for ${role}` })).toBeVisible();
      await expect(page.locator(BANNER)).toContainText(/Snapshot\s+v2/);
      await expect(page.getByRole("heading", { name: "What changed in v2" })).toBeVisible();
    }
    await viewAs(page, "New member");
    await expect(page.locator("body")).not.toContainText("CANARY-", { useInnerText: true });
    await expect(page.getByText(/\d+ restricted items?\. Ask the approver \(Club President\)\./).first()).toBeVisible();
    await page.goto(`/w/${ws}/first-weeks`);
    await expect(page.getByText("Viewing as New member: read only.")).toBeVisible();
    await expect(page.getByText("Only Incoming tech lead records findings.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Record a finding" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("CANARY-", { useInnerText: true });
  });

  await test.step("leak check still passes for every role and surface", async () => {
    await page.goto(`/w/${ws}/handover`);
    const leak = page.locator('section[aria-labelledby="leak-h"]');
    await expect(leak).toBeVisible({ timeout: 60_000 });
    await expect(leak.getByText(/All \d+ checks pass$/)).toBeVisible();
  });
});
