# Argus

A product-agnostic toolkit for running software work with AI agents in two tiers.

- **Orchestrator** session: runs discovery, picks work, writes self-contained prompts to disk. Never writes code.
- **Worker** session: starts cold from a prompt file. Code, self-review, sub-agent review, PR, final report. Stops at an open PR.

Everything persists to disk, so sessions resume. GitHub issues are the work tracker. Argus contains no product knowledge: each consuming repo supplies one `argus.config.json`.

Status: **v0.2**. Claude Code and Copilot CLI telemetry, pricing, the ledger and SQLite index are in. VS Code Copilot Chat logs are not parsed. See [docs/telemetry.md](docs/telemetry.md) and the roadmap in [docs/architecture.md](docs/architecture.md).

## Use it in a repo
1. Vendor the `argus/` folder: `node <argus checkout>/argus/tools/argus.mjs sync --from <git url or checkout> [--ref <tag>]`. This writes `argus.lock` (source, commit, version, a hash per file). Do not edit vendored files; customize through `template_dir`. See [docs/sync.md](docs/sync.md).
2. Create the config: `node argus/tools/argus.mjs onboard --name "My Product" [--tracker owner/repo] [--also api=../api,db=../db] [--labels]`. It fills only what it can detect and lists the rest as `unset`. Or copy `argus/argus.config.example.json`. Schema: `argus/schema/config.schema.json`. An agent can follow `argus/skills/onboarding/SKILL.md`.
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
| `adapters/` | Host mapping (Claude Code, Copilot CLI, generic) |

## CLI
`node argus/tools/argus.mjs help`

## Develop
`npm test` runs offline tests with no network and no real git.

## License
MIT. See [LICENSE](LICENSE).
