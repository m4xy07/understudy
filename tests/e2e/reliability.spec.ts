// Abuse cases a judge will try: bad input, an empty state, a refresh, the same action twice.
// Nothing may break, hang, show a raw error or do the work twice. Runs against a local server
// with the model disabled (as in CI) or the live app:
//   E2E_BASE_URL=https://understudy-lyart.vercel.app pnpm test:e2e
import { expect, test, type Page } from "@playwright/test";

const NOT_FOUND = "This workspace or page does not exist.";
const WS_URL = /\/w\/([0-9a-f-]{36})\/connect/;

/** Fail the test on anything a visitor would see as "broken": a page error or a 5xx answer. */
function watch(page: Page, problems: string[]) {
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
}

async function viewAs(page: Page, label: string) {
  const select = page.locator("header select");
  if ((await select.locator("option:checked").textContent()) === label) return;
  await select.selectOption({ label });
  await expect(select.locator("option:checked")).toHaveText(label, { timeout: 30_000 });
  await expect(page.getByText("Switching…")).toHaveCount(0);
}

async function startEmpty(page: Page): Promise<string> {
  await page.goto("/");
  // A double click must still make one workspace and land on it.
  await page.getByRole("button", { name: /Start empty/ }).dblclick();
  await page.waitForURL(WS_URL, { timeout: 90_000 });
  return WS_URL.exec(page.url())![1];
}

const file = (name: string, content: string | Buffer, mimeType = "text/plain") =>
  ({ name, mimeType, buffer: typeof content === "string" ? Buffer.from(content) : content });

test("an unknown or malformed workspace id shows a not-found page with a way back", async ({ page, request }) => {
  const problems: string[] = [];
  watch(page, problems);
  for (const id of ["nope", "00000000-0000-0000-0000-000000000000", "%3Cscript%3E"]) {
    for (const path of ["", "/connect", "/ask", "/review", "/handover", "/source/x"]) {
      await page.goto(`/w/${id}${path}`);
      await expect(page.getByRole("heading", { name: NOT_FOUND })).toBeVisible();
      await expect(page.getByRole("link", { name: "Start again" })).toHaveAttribute("href", "/");
    }
    const run = await request.get(`/api/w/${id}/run`);
    expect(run.status()).toBe(404);
    expect(await run.json()).toEqual({ error: "Workspace not found." });
    expect((await request.post(`/api/w/${id}/run`)).status()).toBe(404);
    expect((await request.get(`/api/w/${id}/export`)).status()).toBe(404);
    const up = await request.post(`/api/w/${id}/upload`, { multipart: { kind: "markdown" } });
    expect(up.status()).toBe(404);
    expect(await up.json()).toEqual({ ok: false, error: "Workspace not found." });
  }
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: NOT_FOUND })).toBeVisible();
  expect(problems).toEqual([]);
});

test("the cleanup route is closed to anyone without the secret", async ({ request }) => {
  const attempts: Record<string, string>[] = [{}, { authorization: "Bearer guess" }];
  for (const headers of attempts) {
    const res = await request.get("/api/cron/purge", { headers });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Not authorised." });
  }
});

test("an empty workspace: every page says what to do next, for every role", async ({ page }) => {
  const problems: string[] = [];
  watch(page, problems);
  const ws = await startEmpty(page);
  await expect(page.getByText("No sources yet. Upload a file or open a demo.")).toBeVisible();
  await expect(page.getByText("Add at least one source first.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run Understudy" })).toBeDisabled();

  const labels = await page.locator("header select option").allTextContents();
  expect(labels.length).toBeGreaterThan(1);
  for (const label of labels) {
    await viewAs(page, label);
    for (const path of ["claims", "test", "ask", "review", "handover", "evaluation", "source/none"]) {
      await page.goto(`/w/${ws}/${path}`);
      await expect(page.locator("main h1")).toBeVisible();
      await expect(page.getByText("Loading…")).toHaveCount(0);
      // The header always names the next step and links to it.
      await expect(page.getByRole("navigation", { name: "Handover steps" })).toContainText("Next: Connect");
      await expect(page.locator("body")).not.toContainText(/Application error|Something went wrong|Internal Server Error/);
    }
  }
  await page.goto(`/w/${ws}/handover`);
  await expect(page.getByText(/hasn't approved a handover yet/)).toBeVisible();
  expect(problems).toEqual([]);
});

test("uploads: bad files are refused with a reason, a good file twice is stored once", async ({ page }) => {
  const problems: string[] = [];
  watch(page, problems);
  const ws = await startEmpty(page);
  const form = page.locator('form[aria-labelledby="up-h"]');
  const uploads: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/api/w/${ws}/upload`)) uploads.push(r.url());
  });
  const send = async (kind: string, f: ReturnType<typeof file>) => {
    await form.getByLabel("Source type").selectOption(kind);
    await form.locator('input[type="file"]').setInputFiles(f);
    await form.getByRole("button", { name: "Upload" }).click();
  };
  const alert = form.getByRole("alert");

  await expect(form.getByText("Files (4.5 MB max)")).toBeVisible();

  // A zero-byte file and a file over the limit never leave the browser.
  await send("tasks_csv", file("empty.csv", ""));
  await expect(alert).toHaveText(/"empty.csv" is empty\. Choose a file with content\./);
  await send("whatsapp", file("big.txt", Buffer.alloc(5 * 1024 * 1024, "a")));
  await expect(alert).toHaveText(/Upload is over 4\.5 MB\. Split it or trim it\./);
  expect(uploads).toHaveLength(0);

  // Wrong type, malformed CSV, malformed JSON, malformed calendar: refused by the server, in words.
  await send("tasks_csv", file("photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0, 0xff, 0xfe]), "image/png"));
  await expect(alert).toHaveText(/"photo.png" does not look like a text file/);
  await send("tasks_csv", file("board.csv", 'foo,bar\n"unterminated,1\n'));
  await expect(alert).toHaveText(/Nothing could be read from "board.csv" as a task board CSV: header must be exactly/);
  await send("slack", file("general.json", "{not json"));
  await expect(alert).toHaveText(/Nothing could be read from "general.json" as a Slack export/);
  await send("ics", file("cal.ics", "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:garbage\n"));
  await expect(alert).toHaveText(/not a valid iCalendar file/);
  await expect(page.getByText("No sources yet. Upload a file or open a demo.")).toBeVisible(); // nothing was stored

  // A good file, with a double click on Upload: one request, one source.
  const before = uploads.length;
  await form.getByLabel("Source type").selectOption("markdown");
  await form.locator('input[type="file"]').setInputFiles(file("deploy.md", "# Deploy\n\nThe owner of deploys is Arjun. The deadline is 1 Dec.\n", "text/markdown"));
  await form.getByRole("button", { name: "Upload" }).dblclick();
  await expect(form.getByRole("status")).toHaveText(/Imported "deploy.md": 1 segments \(1 new\)/);
  expect(uploads.length - before).toBe(1);
  // The same file again adds nothing new.
  await form.locator('input[type="file"]').setInputFiles(file("deploy.md", "# Deploy\n\nThe owner of deploys is Arjun. The deadline is 1 Dec.\n", "text/markdown"));
  await form.getByRole("button", { name: "Upload" }).click();
  await expect(form.getByRole("status")).toHaveText(/Imported "deploy.md": 1 segments \(0 new\)/);
  await expect(page.getByText("1 connected")).toBeVisible();

  // GitHub URL field: empty, not a URL, not GitHub, no repository, far too long.
  const gh = page.locator('form[aria-labelledby="gh-h"]');
  const url = gh.getByLabel("Repository URL");
  for (const [value, message] of [
    ["   ", /Paste a public GitHub repository URL\./],
    ["not a url", /Not a GitHub repository URL/],
    ["https://example.com/owner/repo", /Not a GitHub repository URL/],
    ["https://github.com/only-an-owner", /Use https:\/\/github\.com\/<owner>\/<repo>\./],
  ] as const) {
    await url.evaluate((el: HTMLInputElement) => el.removeAttribute("required"));
    await url.fill(value);
    await gh.getByRole("button", { name: "Import repository" }).click();
    await expect(gh.getByRole("alert")).toHaveText(message);
  }
  const long = await page.request.post(`/api/w/${ws}/github`, { data: { url: `https://github.com/${"a".repeat(4000)}/b` } });
  expect(long.status()).toBe(400);
  expect((await long.json()).error).toMatch(/too long to be a GitHub repository URL/);
  expect(problems).toEqual([]);

  // Run with a double click and three more starts at once: one run, the rest attach to it.
  await test.step("the pipeline cannot run twice at once", async () => {
    await page.getByRole("button", { name: "Run Understudy" }).dblclick();
    const starts = await page.evaluate(async (id) =>
      Promise.all([1, 2, 3].map(async () => (await fetch(`/api/w/${id}/run`, { method: "POST" })).json())), ws);
    await page.reload(); // a refresh mid-run keeps following the same run
    await expect(page.getByText("Run finished. Open Reconstruct to see the claims.")).toBeVisible({ timeout: 120_000 });
    const status = await (await page.request.get(`/api/w/${ws}/run`)).json();
    expect(status.run.status).toBe("done");
    // Every start that found the run in progress got its id; none started a second one.
    const ids = new Set<string>(starts.map((s: { runId: string }) => s.runId));
    expect(ids.size).toBeLessThanOrEqual(2); // the clicked run, or (if it had already ended) one more
    expect(starts.filter((s: { alreadyRunning: boolean }) => !s.alreadyRunning).length).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Run again" })).toBeEnabled();
    expect(problems).toEqual([]);
  });
});

test("the same action twice: answer, plan, snapshot, in one tab and in two", async ({ page, context }) => {
  const problems: string[] = [];
  watch(page, problems);
  let ws = "";

  await test.step("open the demo with a double click; refresh while the pipeline runs", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open the robotics-club demo" }).dblclick();
    await page.waitForURL(WS_URL, { timeout: 90_000 });
    ws = WS_URL.exec(page.url())![1];
    await page.reload();
    // Opening other pages before the pipeline has finished shows pages, not errors.
    for (const path of ["ask", "review", "handover", "test"]) {
      await page.goto(`/w/${ws}/${path}`);
      await expect(page.locator("main h1")).toBeVisible();
    }
    await page.goto(`/w/${ws}/connect`);
    await expect(page.getByText("Run finished. Open Reconstruct to see the claims.")).toBeVisible({ timeout: 300_000 });
    // Three starts at the same moment: one run, two attach.
    const starts = await page.evaluate(async (id) =>
      Promise.all([1, 2, 3].map(async () => (await fetch(`/api/w/${id}/run`, { method: "POST" })).json())), ws);
    expect(new Set(starts.map((s: { runId: string }) => s.runId)).size).toBe(1);
    expect(starts.filter((s: { alreadyRunning: boolean }) => !s.alreadyRunning)).toHaveLength(1);
    await page.reload();
    await expect(page.getByText("Run finished. Open Reconstruct to see the claims.")).toBeVisible({ timeout: 300_000 });
  });

  await test.step("Ask: blank answers are refused; one question answered from two tabs is stored once", async () => {
    await page.goto(`/w/${ws}/ask`);
    await viewAs(page, "Priya (outgoing tech lead)");
    const open = (p: Page) => p.locator("ol > li", { has: p.getByRole("button", { name: "Save answer" }) }).first();
    await open(page).getByLabel("Your answer").fill("     ");
    await open(page).getByRole("button", { name: "Save answer" }).click();
    await expect(open(page).getByRole("alert")).toHaveText(/Write an answer first\./);

    const tab = await context.newPage();
    watch(tab, problems);
    await tab.goto(`/w/${ws}/ask`);
    await expect(tab.getByRole("heading", { name: /^Open questions \([1-9]\d*\)$/ })).toBeVisible();
    await open(page).getByLabel("Your answer").fill("Arjun owns this from now on. The steps are in docs/DEPLOY.md and he has done them once with me.");
    await open(tab).getByLabel("Your answer").fill("Kabir owns this one. It is written in the club wiki.");
    await Promise.all([
      open(page).getByRole("button", { name: "Save answer" }).dblclick(),
      open(tab).getByRole("button", { name: "Save answer" }).click(),
    ]);
    // One of the two saves wins; the other is told, in words, that nothing was saved twice.
    await expect(page.getByRole("heading", { name: /^Answered \(1\)$/ })).toBeVisible({ timeout: 60_000 });
    await tab.reload();
    await expect(tab.getByRole("heading", { name: /^Answered \(1\)$/ })).toBeVisible();
    await expect(page.getByText(/^Re-test after this answer:/)).toHaveCount(1);
    await tab.close();
  });

  await test.step("Review: bad plan input is refused; the snapshot is approved once however often it is asked", async () => {
    await page.goto(`/w/${ws}/review`);
    await viewAs(page, "Club President");
    const start = page.getByRole("region", { name: "Where to start" });
    await start.getByRole("button", { name: /^Approve \d+ tier A claims?$/ }).dblclick();
    await expect(start.getByRole("button", { name: /tier A/ })).toHaveCount(0, { timeout: 60_000 });

    const cards = page.locator('section[aria-labelledby="plan-h"] li');
    const first = cards.first();
    await first.getByLabel("Owner").fill("   ");
    await first.getByLabel("Due date").fill("2026-11-30");
    await first.getByLabel("Risk note").fill("   ");
    await first.getByRole("button", { name: "Save" }).click();
    await expect(first.getByRole("alert")).toHaveText(/Owner, due date and risk note are all required\./);
    await first.getByLabel("Owner").fill("A".repeat(500));
    await first.getByLabel("Risk note").fill("Deploys wait.");
    await first.getByRole("button", { name: "Save" }).click();
    await expect(first.getByRole("alert")).toHaveText(/Keep the owner under 200 characters/);

    const n = await cards.count();
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      await card.getByLabel("Owner").fill("Arjun Mehta");
      await card.getByLabel("Due date").fill("2026-11-30");
      await card.getByLabel("Risk note").fill("Deploys wait until Arjun has done one with a mentor.");
      await card.getByRole("button", { name: "Save" }).dblclick();
      await expect(card.getByText(/^\W*Planned$/)).toBeVisible({ timeout: 30_000 });
    }

    // Two tabs press Approve at the same moment, one of them twice.
    const tab = await context.newPage();
    watch(tab, problems);
    await tab.goto(`/w/${ws}/review`);
    const snap = (p: Page) => p.locator('section[aria-labelledby="snap-h"]');
    await expect(snap(tab).getByRole("button", { name: "Approve snapshot v1" })).toBeEnabled();
    await page.reload();
    await expect(snap(page).getByRole("button", { name: "Approve snapshot v1" })).toBeEnabled();
    await Promise.all([
      snap(page).getByRole("button", { name: "Approve snapshot v1" }).dblclick(),
      snap(tab).getByRole("button", { name: "Approve snapshot v1" }).click(),
    ]);
    await expect(snap(page).locator("table")).toContainText("v1", { timeout: 60_000 });
    await page.reload();
    await expect(snap(page).locator("table tbody tr")).toHaveCount(1); // v1 only: no v2 from the repeat
    await tab.close();

    // Approving again with nothing changed is a no-op that says so.
    await snap(page).getByRole("button", { name: /^Approve snapshot v2$/ }).click();
    await expect(snap(page).getByRole("status").filter({ hasText: "already covers exactly this state" })).toBeVisible({ timeout: 60_000 });
    await page.reload();
    await expect(snap(page).locator("table tbody tr")).toHaveCount(1);

    // Back after the action: the earlier page renders, nothing is re-submitted.
    await page.goBack();
    await expect(page.locator("main h1")).toBeVisible();
    await page.goto(`/w/${ws}/review`);
    await expect(snap(page).locator("table tbody tr")).toHaveCount(1);
  });

  await test.step("Handover: an acknowledgement pressed twice is recorded once; a re-run keeps the handover", async () => {
    await page.goto(`/w/${ws}/handover`);
    await viewAs(page, "Incoming tech lead");
    await expect(page.getByRole("heading", { name: "Handover for Incoming tech lead" })).toBeVisible();
    await page.getByRole("button", { name: "Check my read-back" }).click(); // empty read-back: a verdict, not an error
    await expect(page.getByText(/\d+ of \d+ items match the snapshot\./)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Acknowledge receipt" }).dblclick();
    await expect(page.getByText(/Receipt acknowledged/).first()).toBeVisible({ timeout: 30_000 });

    // Running the pipeline again (twice at once) after approval does not take the handover away.
    await page.evaluate(async (id) => Promise.all([1, 2].map(() => fetch(`/api/w/${id}/run`, { method: "POST" }))), ws);
    await page.goto(`/w/${ws}/connect`);
    await expect(page.getByText("Run finished. Open Reconstruct to see the claims.")).toBeVisible({ timeout: 300_000 });
    await page.goto(`/w/${ws}/handover`);
    await expect(page.getByRole("heading", { name: "Handover for Incoming tech lead" })).toBeVisible();
    await expect(page.locator("#release-h")).toHaveCount(1); // streamed content has settled
    await expect(page.locator("#release-h")).toContainText(/Released with (no|\d+) open blocking gaps?/);
    const md = await page.request.get(`/api/w/${ws}/export`);
    expect(md.status()).toBe(200);
    expect(await md.text()).toContain("# Handover for Incoming tech lead");
  });

  expect(problems).toEqual([]);
});
