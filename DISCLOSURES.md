# Disclosures

Team DRACONIX (CodersInPune) · Understudy · Knowledge Handover challenge, Round 2

## Build window

All product code in this repository was written during the Round 2 build window. The first commit (`1001ead`, 11 Nov 2026, 00:11 IST) is the framework scaffold plus our plan and architecture contract; the history after it shows the work in small steps.

The research, the product design and the plan come from our Round 1 submission and were done before the build window, as the rules allow. They are carried into [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/plan/2026-11-11-round2-build-plan.md](docs/plan/2026-11-11-round2-build-plan.md). Where the build differs from the Round 1 plan, the README section "Against the Round 1 plan" says what changed and why.

## Boilerplate

The app started from the standard `create-next-app` scaffold (Next.js, TypeScript, Tailwind CSS, ESLint). Its default files (`layout.tsx`, `globals.css`, `eslint.config.mjs`, `tsconfig.json`, `next-env.d.ts`, `favicon.ico`) were kept or rewritten. No other template, starter kit or earlier codebase was used.

`AGENTS.md` is written by `next dev` itself and tells coding agents to read the Next.js docs bundled in `node_modules`.

## AI assistance

We used AI coding tools, including Claude Code, to write and test much of the code and documentation, under our direction and review. We set the product rules, the architecture contract and the module boundaries, and we decided what to keep.

The product's own runtime model is Qwen3 (open weights): `qwen/qwen3-32b` through OpenRouter for the hosted demo, and `qwen3:8b` on Ollama for local use. It drafts claims, runs the support check and plays the stand-in successor. Code sets every label, role set, status, score, tier and approval. Handover text comes from fixed templates, not from the model.

The demo's precomputed extraction answers from `qwen/qwen3-32b` are committed in `data/demo/model_cache.json` so the demo replays the same claims.

## Open-source libraries

Licences below are read from each package's `package.json` in `node_modules`, at the versions in `pnpm-lock.yaml`.

### Runtime

| Package | Version | Licence | Purpose |
|---|---|---|---|
| next | 16.4.6 | MIT | Web framework: pages, server actions, API routes |
| react, react-dom | 19.3.0 | MIT | UI |
| postgres | 4.1.0 | Unlicense | Postgres driver (porsager/postgres) |
| zod | 4.6.7 | MIT | Validating model output, the setting pack and inputs |
| papaparse | 5.7.0 | MIT | Task board CSV parsing |
| gray-matter | 4.0.3 | MIT | Front matter in Markdown notes |
| ical.js | 2.2.1 | MPL-2.0 | Calendar (.ics) parsing and expanding recurring events |
| clsx | 2.1.1 | MIT | Class name joining |
| yaml | 2.9.1 | ISC | Installed for YAML parsing; not imported by the current code |
| rrule | 2.8.1 | BSD-3-Clause | Installed for recurrence rules; not imported (ical.js expands them) |
| lucide-react | 1.71.0 | ISC | Installed for icons; not imported (the UI uses text symbols) |

### Development and testing

| Package | Version | Licence | Purpose |
|---|---|---|---|
| vitest | 5.1.0 | MIT | Unit, integration, permission and canary tests |
| tsx | 4.23.15 | MIT | Running TypeScript scripts (migrate, seed, eval) |
| @playwright/test | 1.65.0 | Apache-2.0 | End-to-end runs on the live URL (status in TESTING.md) |
| tailwindcss, @tailwindcss/turbopack | 4.3.3 | MIT | Styling |
| eslint | 9.39.5 | MIT | Linting |
| eslint-config-next | 16.4.6 | MIT | Next.js lint rules |
| typescript | 5.9.3 | Apache-2.0 | Type checking |

Type packages (`@types/node`, `@types/react`, `@types/react-dom`, `@types/papaparse`) are MIT, from DefinitelyTyped.

## Hosted services

| Service | Used for |
|---|---|
| Vercel | Hosting the live app; functions pinned to region `icn1` |
| Supabase | Production Postgres with row-level security, reached through the transaction pooler |
| OpenRouter | OpenAI-compatible endpoint for `qwen/qwen3-32b` on the hosted demo |
| GitHub | Code hosting; the public GitHub API when a visitor imports a public repo URL |

Local development uses Docker (`postgres:16`) and, optionally, Ollama.

## Data

- The demo data in `data/demo/` is synthetic. The robotics club, its members (including Priya) and every company and sponsor are fictional.
- It contains deliberately planted FAKE secrets so masking can be shown: an AWS-style access key pair, a GitHub-style token and a password line. The masking tests in `tests/tether/mask.test.ts` add more fake values, including a Slack-style token. None of them is real or was ever valid.
- Contact emails and phone numbers in the demo are made up.
- Restricted demo sources carry `CANARY-XXXX` tokens for the leak check. They are markers, not data.
- No real personal or company data was used to build or test the product. The upload screen warns visitors not to upload confidential material.
