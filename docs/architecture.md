# Architecture

## Shape
Two tiers, no daemon. Files are the contract between sessions.

```
human ── discovery ──> requirements.md   (owned by the consuming repo)
                            │
orchestrator ── argus render ──> prompt.md ──┐
   │  (never writes code)                    │ dispatch (adapter or manual)
   │                                         v
   │                                  worker (cold start)
   │                                   code → self-review → sub-agent review → PR
   │                                         │
   └── argus report-check <── final-report.json
```

## What lives where
| Concern | Owner | Location |
| --- | --- | --- |
| Templates, schema, CLI, roles | Argus | `argus/` (vendored or copied) |
| Product facts, policies, rules, test commands | Consuming repo | `argus.config.json` and the files it points at |
| Requirements | Consuming repo | `requirements_dir`, default `<orchestration_dir>/<issue>/` |
| Prompts, diffs, reviews, reports, status | Consuming repo | `orchestration_dir` |
| Work tracking | GitHub | issues, sub-issues, `argus:*` labels |

## Principles
1. **Disk is memory.** Every artifact is a file, so any session can resume.
2. **Live beats cached.** Decisions use a fresh tracker read. `status.md` is a dashboard.
3. **No guessing.** Telemetry is machine-sourced, labeled self-reported, or null with a reason. Template fields that are missing are errors.
4. **Deterministic work is code.** Config discovery, rendering, linting, planning, claiming, status and report validation run in the CLI and spend no LLM tokens.
5. **Real dispatch for review.** A reviewer is a separate agent. No dispatch, no review, halt.
6. **Zero product knowledge in `argus/`.** A test enforces it.

## Multi-repo solutions
One anchor repo holds `argus.config.json`. Its `repos` map lists every repo (UI, service, database). Stories name a repo. Cross-repo order is expressed with `depends_on`. `argus plan` turns that graph into waves, serializes stories with overlapping files, and caps concurrency.

## Config discovery
`--config`, then `ARGUS_CONFIG`, then walk up from the working directory and the tool directory, then a single-sibling scan. The scan dedupes worktrees by resolved git identity. Zero matches is `null`, one is used, several distinct repos is an error.

## Claiming work
GitHub has no atomic claim. Claim comment plus `argus:claimed` label, then re-read. The earliest claim comment wins and only the winner labels or assigns.

## Roadmap
| Version | Scope |
| --- | --- |
| v0.1 | This release: config, discovery track, roles, templates, CLI, claim, plan, report contract |
| v0.2 | Shipped: JSONL ledger, rebuildable SQLite index, Claude Code and Copilot CLI parsers, effective-dated pricing with drift check, budget guard rollup. Not shipped: VS Code chatSessions parser, scheduled pricing-update workflow |
| v0.3 | Shipped: `argus sync` vendoring with `argus.lock`, budget guard wired into `plan` and `claim`. `argus onboard` plus an onboarding skill, one-way cross-solution `argus export` |
| v0.4 | Prompt-learning loop: analyze outcomes by template version, propose template changes as PRs |

## Design decisions still open
- SQLite index location is per solution. Cross-product learning is an optional one-way export to a primary solution (`argus export`, see `docs/telemetry.md`).
- Pricing automation opens PRs against `pricing/`. Rates are never auto-merged.
- The Claude Code adapter has no tested end-to-end dispatch yet. It is documented, not exercised in CI.
