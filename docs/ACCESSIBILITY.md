# Accessibility of the successor's journey

Our Round 1 plan promised two things: every action works with the keyboard, and status is never shown by colour alone.
This page says how we checked that for three pages (Test, Ask and First weeks), what we fixed, and what we did not cover.

## What was checked

**Automatic, with axe** (`tests/e2e/accessibility.spec.ts`, `@axe-core/playwright`). The test opens the robotics-club demo and scans, with the WCAG 2.0, 2.1 and 2.2 A and AA rules plus axe's best-practice rules:

- Test, as the Incoming tech lead and as the New member (the second tested role).
- Ask, as the leaver.
- Ask after an answer is saved.
- Ask as the Club President with "cannot be reached" switched on, and the same page as the Incoming tech lead.
- First weeks as the Incoming tech lead: the list, the finding form open, and after a finding is saved. Then as the Club President.

The test fails on any serious or critical violation. It also fails on an unresolved `aria-prohibited-attr` check, because axe could not decide that one by itself and it turned out to be a real defect.

**By keyboard** (same file). Two tests use only Tab, Enter and Space after the page is open:

1. As the leaver on Ask: switch role with the menu, reach the answer box, press Space on "Use a sample answer", Tab to "Save answer", press Enter. The test checks the Tab order, that focus lands on the "Open questions" heading after the form goes away, and that the new score is in a status region.
2. As the Incoming tech lead on First weeks: open a finding form with Space, Cancel with Enter (focus returns to the button), then on the example gap fill the example with Enter, Tab to "Save finding", press Enter. The test checks the Tab order and that focus lands on the saved message.

**By reading the code.** Axe cannot see focus handling, live regions or the quality of a link name, so we read the three pages and the shared components for those.

## What we found and fixed

Axe found no serious or critical violation on the pages as they were. The app already had labels on every field, `scope` on table headers, symbol plus word on every chip, a visible focus outline and a skip link. What it did find, and what reading found:

| Problem | Fix |
|---|---|
| The score line put `aria-label` on a plain `span`. Axe marks this as undecidable, and screen readers may ignore it. | The full sentence ("B 4 blocking gaps, C 76% coverage, K 100% backed by records") is hidden text. The short form is hidden from screen readers. (`src/components/Scores.tsx`) |
| After an answer, the score changed with no announcement. The status message in the answer form was lost, because the form removes itself. | The score block on Test and Ask is a status region. The "Last answer" line is inside it. |
| Pressing "Save answer" removed the focused button, so focus fell to the top of the page. | `ActionForm` takes `focusOnRemove`: after a submit, if the form is removed, focus moves to a named heading. Used by the answer form and the neighbour form. |
| On First weeks, "Record a finding" disappeared when the form opened, and focus was lost. Cancel and Save did the same. | Focus moves into the form when it opens, back to the button on Cancel, and onto the message after a save. |
| Repeated controls had identical names: "Record a finding", "Open evidence", "Withdraw", and evidence ids on Test. | Hidden text adds the gap or check they belong to. |
| The findings table had no caption. | Caption added. |
| The "recovery" spinner kept turning for people who ask for less motion. | `motion-reduce:animate-none`. |

Scoring, questions, prompts and data were not touched.

## What is not covered

- **No screen reader was used.** We checked names, roles and live regions in the browser's accessibility tree through Playwright and axe. We did not listen to NVDA, JAWS or VoiceOver. Live region wording is untested by ear.
- **Axe finds only part of the problems.** Treat a green run as "no known automatic failures", not as "accessible".
- **Colour contrast is only partly decided by axe.** It passed 352 contrast checks on Test and 95 on Ask. About 80 more were "incomplete" (axe could not read a background), and these are decorative symbols inside chips. The words beside them were checked and pass. We did not measure the hover states.
- **The "Viewing as" menu applies a choice as soon as it changes**, so arrow keys can switch role one option at a time. A confirm step would be better. We left it because the demo guide and the other browser tests rely on it. Typing the start of a role name works well.
- **Notices that hold a button** (for example "Only Priya answers these") are a status region, so a screen reader may read the button again when the page updates. `Notice` is shared by many pages, so we did not change it here.
- **Some links still share a name** on Ask: "See claim", "Open source". They sit next to the text they belong to.
- **Chip tooltips** (`title`) are not reachable by keyboard. The chip word carries the meaning, so nothing is lost, but the extra detail is.
- **Other pages** (Connect, Reconstruct, Verify, Review, Handover, source view, landing) were not scanned or read for this pass.
- **Not tested:** 200% and 400% zoom, a narrow phone screen, Windows high contrast, touch target size, Firefox and Safari. Only Chromium was used.
- **The setup before the keyboard tests used the mouse** (opening the demo, approving the snapshot in Review). Only the answer and the finding are keyboard only.
- **The tests ran against the dev server** (`pnpm dev`), not a production build.

## How to run the checks

You need the database from the README ("Run it locally") and the browser once:

```bash
pnpm exec playwright install chromium
pnpm dev                       # keep it running
pnpm test:e2e accessibility    # in a second terminal
```

The run opens its own demo copy and takes about a minute. A failure prints each axe rule, the element and what to change. To run against another address, set `E2E_BASE_URL`.
