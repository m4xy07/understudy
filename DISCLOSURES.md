# Disclosures

Team DRACONIX (CodersInPune) · Understudy · Knowledge Handover challenge, Round 3

## Build window

**Round 3.** The window opened at 23:59 IST on Friday 13 November 2026. We wrote the plan, the specs and the decisions before it opened, as documents only, with no product code. They entered this repository as the first Round 3 commit, `dc1041b` (14 Nov 2026, 10:31 IST), which adds only `docs/round3/` and the licence file. The first product commit of Round 3 is `fda0542` (14 Nov 2026, 10:35 IST), after the window opened. The last commit before Round 3 is `05473dd` (11 Nov 2026, 14:40 IST), from the Round 2 window.

You can check this with `git log --date=iso-strict --format="%h %ad %s"`.

**Round 2.** All Round 2 product code was written during the Round 2 build window. The first commit (`1001ead`, 11 Nov 2026, 00:11 IST) is the framework scaffold plus our plan and architecture contract.

**Before any window.** The research, the product design and the Round 1 plan were done before the build windows, as the rules allow. They are carried into [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/plan/2026-11-11-round2-build-plan.md](docs/plan/2026-11-11-round2-build-plan.md) and [docs/round3/](docs/round3/).

## Boilerplate

The app started from the standard `create-next-app` scaffold (Next.js, TypeScript, Tailwind CSS, ESLint). Its default files (`layout.tsx`, `globals.css`, `eslint.config.mjs`, `tsconfig.json`, `next-env.d.ts`, `favicon.ico`) were kept or rewritten. No other template, starter kit or earlier codebase was used.

`AGENTS.md` is written by `next dev` itself and tells coding agents to read the Next.js docs bundled in `node_modules`.

## AI assistance

AI coding tools, mainly Claude Code, wrote much of the code and the documentation, under our direction and review. We set the product rules, the architecture contract, the module boundaries and the specs. We decided what to build, what to keep and what to cut, and we reviewed the results.

Round 3 commits come from three GitHub accounts. You can check with `git log --date=iso --format="%h %an %ad %s"`.

| GitHub account | Round 3 commits |
|---|---|
| `Om072005` (Om) | 6 commits on 14 Nov 2026, 15:50 to 15:56 IST: the claim history view. Merged as pull request #2. |
| `YashM2704` (Yash) | 7 commits on 14 Nov 2026, 15:57 to 16:15 IST: the reworded-fact probe set for the research group. Merged as pull request #1. These commits name Claude as co-author. |
| `m4xy07` (Aman, team lead) | Every other Round 3 commit: the main build (the three improvements, the second setting, extraction, reliability, the fixes), both merges and the review follow-ups to pull request #1. This work was committed from his machine, written with AI coding tools under the team's direction. |

Every Round 2 commit carries the team lead's git identity.

The product's own runtime model is Qwen3 (open weights): `qwen/qwen3-32b` through OpenRouter for the hosted demo, and `qwen3:8b` on Ollama for local use. It drafts claims, runs the support check, plays the stand-in successor, classifies borderline sensitive messages, proposes ranked options and acts as the judge in the reworded-fact probes. Code sets every label, role set, status, score, tier and approval. Handover text comes from fixed templates, not from the model.

The stored model answers that both demos replay are committed in `data/demo/model_cache.json` and `data/lab/model_cache.json`. They were produced by `qwen/qwen3-32b`.

## Open-source libraries

Licences below are read from each package's `package.json` in `node_modules`, at the versions `pnpm install` resolves from `pnpm-lock.yaml`.

### Runtime

| Package | Version | Licence | Purpose |
|---|---|---|---|
| next | 16.4.6 | MIT | Web framework: pages, server actions, API routes |
| react, react-dom | 19.3.0 | MIT | UI |
| postgres | 4.1.0 | Unlicense | Postgres driver (porsager/postgres) |
| zod | 4.6.7 | MIT | Validating model output, the setting packs and inputs |
| papaparse | 5.7.0 | MIT | Task board CSV parsing |
| gray-matter | 4.0.3 | MIT | Front matter in Markdown notes |
| ical.js | 2.2.1 | MPL-2.0 | Calendar (.ics) parsing and recurring events |
| clsx | 2.1.1 | MIT | Class name joining |

The UI uses text symbols, not an icon library.

### Development and testing

| Package | Version | Licence | Purpose |
|---|---|---|---|
| vitest | 5.1.0 | MIT | Unit, database, permission and leak tests |
| tsx | 4.23.15 | MIT | Running TypeScript scripts (migrate, seed, eval) |
| @playwright/test | 1.65.0 | Apache-2.0 | End-to-end tests in Chromium |
| tailwindcss, @tailwindcss/turbopack | 4.3.3 | MIT | Styling |
| eslint | 9.39.5 | MIT | Linting |
| eslint-config-next | 16.4.6 | MIT | Next.js lint rules |
| typescript | 5.9.3 | Apache-2.0 | Type checking |
| @types/node | 20.19.43 | MIT | Types |
| @types/react, @types/react-dom | 19.3.0 | MIT | Types |
| @types/papaparse | 5.5.2 | MIT | Types |

Understudy itself is released under the MIT licence ([LICENSE](LICENSE)).

## Hosted services

| Service | Used for |
|---|---|
| Vercel | Hosting the live app; functions in region `icn1`; one daily cron for the cleanup |
| Supabase | Production Postgres with row-level security, reached through the transaction pooler |
| OpenRouter | OpenAI-compatible endpoint for `qwen/qwen3-32b` on the hosted demo |
| GitHub | Code hosting and CI (GitHub Actions); the public GitHub API when a visitor imports a public repository URL |

Local development uses Docker (`postgres:16`) and, optionally, Ollama.

## Data

- All demo data in `data/demo/` (the robotics club) and `data/lab/` (the research group) is synthetic. The organisations, their members and every company, sponsor and facility are fictional.
- The data contains deliberately planted FAKE secrets so masking can be shown: AWS-style access keys, GitHub-style tokens and password lines. The masking tests add more fake values. None of them is real or was ever valid.
- Contact emails and phone numbers in the demos are made up.
- Restricted demo sources carry `CANARY-XXXX` tokens for the leak check. They are markers, not data.
- The club demo also holds planted sensitive messages (a medical excuse, a fee dispute, a complaint about a person) and reworded restricted facts, so the classifier and the probes have something to find. They describe fictional people.
- No real personal or company data was used to build or test the product. The upload screen asks visitors not to upload confidential material.
