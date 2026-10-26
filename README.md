# Argus

A product-agnostic toolkit for running software work with AI agents in two tiers.

- **Orchestrator** session: runs discovery, picks work, writes self-contained prompts to disk. Never writes code.
- **Worker** session: starts cold from a prompt file. Code, self-review, sub-agent review, PR, final report. Stops at an open PR.

Everything persists to disk, so sessions resume. GitHub issues are the work tracker. Argus contains no product knowledge: each consuming repo supplies one `argus.config.json`.

Status: **v0.2**. Claude Code telemetry, pricing, the ledger and SQLite index are in. Copilot parsing is blocked on a real log sample. See [docs/telemetry.md](docs/telemetry.md) and the roadmap in [docs/architecture.md](docs/architecture.md).

## Use it in a repo
1. Copy the `argus/` folder into the repo (or vendor it; `argus sync` arrives in v0.3). Do not edit vendored files. Customize through `template_dir`.
2. Copy `argus/argus.config.example.json` to the anchor repo root as `argus.config.json` and fill it in. Schema: `argus/schema/config.schema.json`.
3. Check it: `node argus/tools/argus.mjs config`
4. Scaffold a story: `node argus/tools/argus.mjs init 12`
5. Start an orchestrator session with `argus/quickref.md` and `argus/roles/orchestrator.md`.

Requires Node 22.13 or later and the `gh` CLI for tracker commands. No npm dependencies.

## What is in `argus/`
| Path | Purpose |
| --- | --- |
| `quickref.md` | Always-loaded cheat sheet, under 1k tokens |
| `roles/` | Orchestrator, worker, reviewer |
| `checklists/pre-generation.md` | Gate before any worker prompt is written |
| `discovery/` | Definition of Ready, question rubric, standing policies |
| `templates/` | Worker prompt, code review, requirements, status, parking list |
| `contracts/final-report.md` | Report contract, enforced by `argus report-check` |
| `schema/config.schema.json` | Documented config schema |
| `pricing/` | Versioned rate files, checked against Claude Code's own recorded cost |
| `tools/` | Zero-dependency CLI |
| `adapters/` | Host mapping (Claude Code, generic) |

## CLI
`node argus/tools/argus.mjs help`

## Develop
`npm test` runs offline tests with no network and no real git.

## License
MIT. See [LICENSE](LICENSE).
