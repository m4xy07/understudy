# Roadmap

What we would build after Round 3, in this order. Each item names who it serves, the work involved, and what must be true before we start it. Nothing here is built yet unless the item says so.

The order follows one rule: first make a real team able to use Understudy with real people and real data, then widen what it reads, then widen who it fits.

| # | Item | Serves | Size |
|---|---|---|---|
| 1 | Invite links and real sign-in | Any team outside a demo | About 1 week |
| 2 | Live connectors with scoped permissions | The person who sets up a handover | 2 to 3 weeks for the first two |
| 3 | Bus-factor view before anyone leaves | Team leads and approvers | About 1 week |
| 4 | More setting packs | Teams that are not a club or a lab | 2 to 3 days per pack, plus one core change |
| 5 | Self-hosted model packaging | Teams that cannot send text to a hosted model | About 1 week |
| 6 | Accessibility audit | Everyone, and any institution that must meet WCAG | 3 to 4 days, then fixes |

## 1. Invite links and real sign-in

**Who it serves.** A team that wants to use Understudy on a real handover. Today anyone with a workspace link can pick any role in the "Viewing as" menu. That is right for a demo and wrong for real data.

**What exists.** Row-level security already decides what a role reads, on every role-scoped query. The schema has `workspaces.access_mode` (`open` today, `invite` reserved) and the daily cleanup already leaves a locked workspace alone.

**The work.**
- A one-way "Lock roles" switch for the approver. After it, the role switcher is gone for that workspace.
- One signed invite link per role holder. Opening it sets a session bound to that workspace and role. The approver can revoke a link.
- Server actions read the role from the session, not from the role cookie. The demo keeps the open switcher.
- Later: sign-in with an identity provider (Google or Microsoft) for teams that want named accounts. The role still comes from the workspace, not from the provider.

**What must be true first.** A signing key in the environment and a rotation rule for it. A test that a locked workspace refuses every role change without a valid link, for every page and API route.

## 2. Live connectors with scoped permissions

**Who it serves.** The person who sets up the handover. Today they export files by hand (WhatsApp, Slack, a task board CSV, notes, a calendar) or paste a public GitHub URL.

**The work.**
- Slack first, then Google Drive or Google Calendar. Each connector asks for read-only scopes and lets the approver pick channels or folders one by one. Nothing is read that was not picked.
- Each picked channel or folder gets its role set at connect time, on the same screen. The sensitive-content classifier runs at ingest as it does today.
- Tokens are stored encrypted, like contact details, and can be revoked from the Connect page. A re-sync creates new segment versions; existing rules for versions and visibility apply.
- The adapters do not change: a connector fetches into the same shapes the file adapters already read, as the public GitHub fetch does today.

**What must be true first.** Item 1. We will not attach a live token to a workspace where anyone with the link can become the approver. Also an app registration with each provider, and a written data-retention rule for fetched content.

## 3. Bus-factor view before anyone leaves

**Who it serves.** Team leads and approvers, months before a handover. Understudy today starts when someone is already leaving.

**What exists.** The leaver footprint (work done three or more times, sole ownership of a path or a contact, schedules, credential names) and the collaboration graph built for recovery, which reads metadata only and no message text.

**The work.**
- Run the footprint for every role holder, not only the leaver.
- A page that lists responsibilities only one person holds, with the same typed checks as the successor test, and who the nearest neighbour is.
- The output is a list of gaps to close now, while the person can still answer. It reuses Ask as it is.

**What must be true first.** The page must obey the same role rules as everything else: a role sees only responsibilities built from sources it may read. The leak check gets this page as a new surface before it ships. It should also be opt-in per workspace, because it describes people who are not leaving.

## 4. More setting packs

**Who it serves.** Teams that are not a college club or a research group: a small company team, a student society with elected posts, an open-source project.

**What exists.** A setting is one pack file and one data folder. The research group was added with no setting-specific core code (see [round3/ZERO_CORE_CHANGES.md](round3/ZERO_CORE_CHANGES.md)), and a check in `pnpm test` fails if core names a setting.

**The work.**
- Two or three more packs, each with a small synthetic corpus and an answer key, so extraction quality is measured per setting and not assumed.
- One core change we already know about: the five responsibility kinds are a closed list. A pack should be able to add a kind with its own checks.
- Dates display in IST today. The pack should carry its time zone.
- A short guide for writing a pack, and `check-demo` as the gate a new pack must pass.

**What must be true first.** Each new pack is a hold-out for extraction: we measure it before changing any prompt, as we did for the lab.

## 5. Self-hosted model packaging

**Who it serves.** Teams whose record must not leave their machines. Understudy already talks to any OpenAI-compatible endpoint, and Ollama with `qwen3:8b` works by setting three environment variables.

**The work.**
- One `docker compose` profile that starts the app, Postgres and Ollama together, pulls the model, and needs no key.
- Measure `qwen3:8b` on both answer keys and publish the numbers next to the hosted model's. The hosted demo runs the 32B model, so we do not yet know how far the 8B model falls short.
- A hardware note: what runs acceptably on a laptop CPU, and what needs a GPU.
- Batch sizes and time budgets tuned for a slower local model. Resumable runs already carry a long run across several slices.

**What must be true first.** The evaluation numbers for the small model. If recall is too low to be useful, we say so and recommend a larger local model instead of shipping a default that disappoints.

## 6. Accessibility audit

**Who it serves.** Everyone who uses a keyboard or a screen reader, and institutions that must meet WCAG 2.2 AA before adopting a tool.

**What exists.** Status is never colour alone: every chip has a symbol and a word. Pages are keyboard operable, tables have headers and captions, and every page was checked at 375 px wide. We have not had an independent audit.

**The work.**
- An automated pass (axe) on every page for every role, added to CI.
- A manual pass with NVDA and VoiceOver on the full path: open a demo, review, approve, read the handover, complete the read-back.
- Fixes, then a short conformance statement in the repository.

**What must be true first.** Nothing. This can start at any time and should run again after items 1 to 3 add new screens.

## After these

Smaller items we have noted and not scheduled: batching several findings into one snapshot, a time-left estimate for long runs, lint and the type check as CI jobs, and running the evaluation as a CI gate so a prompt change cannot lower recall unnoticed.
