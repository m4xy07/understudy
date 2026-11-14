# Zero core code changes for the second setting

The claim, stated honestly:

> Adding the research-group setting needed **no setting-specific core code**. The setting is one pack
> file and one data folder. Core was first made setting-neutral in the foundation pass (63 hardcoded
> places removed, before the lab pack was merged). After the merge, one more setting-neutral
> generalisation was made in core, for the landing page. No line of core names the lab, its roles
> or its people, and no migration was needed.

"Core" means `src/`, `db/migrations/` and `next.config.ts`. "Setting data" means `packs/` and `data/`.

## The commits

- Base: `fb4b3f1` (main, the last commit before the lab pack was merged)
- Pack: `603dc72` (tip of the lab pack's branch: `packs/lab.json`, `data/lab/**`, two scripts)
- Head: `058cf2a` (main, the lab demo runs end to end: pipeline, app, tests)
- Pack id: `lab`

`pnpm tsx scripts/check-zero-core.ts` reads these four lines and proves the claim from the git
history. `tests/pack/zero-core.test.ts` runs the same check inside `pnpm test`.

## What is checked

| # | Check | Result |
|---|---|---|
| 1 | The lab pack's branch changed no file under `src/`, `db/migrations/`, `next.config.ts` (nor the seed or migrate script) | 0 files |
| 2 | Every core file changed between Base and Head is listed and explained below | 3 files, all listed |
| 3 | No line added to core between Base and Head holds a lab role key, the pack id `lab`, a lab role label, a lab person or a lab proper noun (the scanner of `scripts/check-literals.ts`, with the lab vocabulary only) | 0 hits |
| 4 | No migration was added or changed | 0 files |
| 5 | The whole of core, at any commit, names no setting at all (`pnpm check:literals`, part of `pnpm test` and CI; now with the lab's 5 role keys and its nouns in the forbidden vocabulary too) | passes |

Reproduce by hand:

```bash
git diff --stat fb4b3f1...603dc72 -- src db next.config.ts   # the pack's branch: prints nothing
git diff --stat fb4b3f1 058cf2a -- src db next.config.ts     # 3 files, see below
pnpm tsx scripts/check-zero-core.ts
pnpm check:literals
```

## Core changes between Base and Head, and why each is setting-neutral

All three belong to one generalisation: the landing page shows **one card per demo pack**, built
from `packs/index.json` and each pack's own `demo` block. Before it, the page showed one button per
demo pack in a row; it already read the list from the pack registry.

| File | What changed | Why it is setting-neutral |
|---|---|---|
| `src/lib/pack/index.ts` | `listPacks()` also returns each pack's role labels (`roles: string[]`) | It maps over `pack.roles` of whatever pack is listed. No pack is named. |
| `src/app/page.tsx` | Passes each demo's title, blurb and role labels to the cards; the footer says "Every demo is fictional and fully synthetic" | Reads `listDemoPacks()`. The copy is the same for one, two or ten packs. |
| `src/app/LandingActions.tsx` | Renders a card per demo (title, blurb, roles, button) and the lines "No sign-up needed" and "Switch roles any time with Viewing as in the top bar" | Loops over the `demos` prop. The card text comes from the pack; the fixed copy names no setting. |

Nothing else in core changed. In particular, none of these needed a change for the lab to work:
the role switcher, the stub text ("Ask the approver (Principal investigator)."), the approval rule in
the application and in the database, RLS, the checklists (the lab defines two checks the club does
not have), the read-back items, the canary leak check, the evaluation page, the model cache.

## What was generalised before the merge (the foundation pass)

The lab runs unchanged on core because core was made setting-neutral first, in 7 commits
(`245c007` to `fb4b3f1`, 60 core files). The full list of 63 hardcoded places is in
`specs/03_living_handover_second_setting.md`, section A7. In short:

- role keys, the approver label, the leaver's name and the prompt examples moved into the pack;
- a workspace reads its own pack (`workspaces.pack_id`), where before every workspace was the club;
- the database rule "only the approver approves, never the leaver" no longer names a role
  (`0006_packs.sql`: a trigger on the workspace's `approver_role` and `leaver_role`);
- the demo folder, the demo's "today", the answer key and the canary tokens are found through
  `pack.demo.dataDir`;
- scripts take `--pack`; there is one model cache file per pack.

Those commits were written against the club alone. The lab pack's branch forked from `dc1041b`,
before that pass, and was written against the spec of the pack shape, not against the code.

## Changes outside core that the lab did need (setting data and tooling)

| File | Change |
|---|---|
| `packs/lab.json`, `data/lab/**` | the setting: pack, corpus, answer key, model cache |
| `packs/index.json` | `"lab"` added to `demos` |
| `scripts/check-demo.ts` | the GitHub-token format rule now accepts what the masker masks (`gh?_` + 20 or more characters), where before it demanded the club's exact 36 |
| `scripts/check-demo-adapters.ts` | new second stage of `check-demo` (was `check-lab.ts` on the pack's branch): the corpus through the real adapters, masker, footprint and inventory; pack-driven |
| `scripts/gen-lab.mjs` | generator of the lab corpus |
| `tests/db/rls.test.ts`, `tests/db/pipeline.packs.test.ts`, `tests/e2e/lab-path.spec.ts` | the RLS suite and a pipeline suite run once per pack; a browser walk of the lab |

## Limits, stated plainly

- The five responsibility kinds are a closed list in core. The lab relabels them and defines its own
  checks; a setting that needs a sixth kind would need a core change.
- Dates display in IST and wall-clock times are read as IST. The lab story is set in Pune.
- Found while bringing the lab live, and left unchanged on purpose: the stand-in successor reads a
  role's claims `ORDER BY entity, attribute, valid_from`, with no final tie-break. Two claims that tie
  can swap places between a cold run and a replayed run, which changes that prompt and so its cache
  key (2 of 50 calls on the lab's first replay). Adding `, id` fixes it but changes four club cache
  keys, so it waits for the one planned precompute of both demos. Until then the lab cache holds both
  orders (47 rows) and replays 50 of 50.
