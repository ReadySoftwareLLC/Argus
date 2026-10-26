# Argus quickref (always loaded, keep under 1k tokens)

Two tiers. **Orchestrator** never writes code: it runs discovery, picks work, writes self-contained prompts to disk, dispatches workers. **Worker** starts cold from a prompt file and runs end to end: code, self-review, sub-agent review, PR, final report. Worker stops at an open PR. A human merges.

## Hard rules
1. Disk is memory. Prompts, diffs, reviews, reports, status all live as files. Chat stays short.
2. Live source of truth (GitHub issue, git, CI) is re-fetched before acting. `status.md` is a dashboard, never authority.
3. Never guess a field. Machine-sourced, or labeled `self_reported`, or `null` with a `reason`.
4. Review is a real sub-agent dispatch. Never paraphrase the reviewer prompt inline. No dispatch available: halt.
5. No product facts in `argus/`. Facts, policies, rules come from `argus.config.json`.
6. Tangents go to `parking-list.md` in one line. Then move on.
7. Never re-ask a standing policy. Ask only what the repo and context cannot answer.

## Tracker
GitHub issues via `gh`. Epic = parent issue, stories = sub-issues. State = labels `argus:ready|claimed|in-progress|in-review|blocked`.

## Commands (`node argus/tools/argus.mjs <cmd>`)
| cmd | use |
| --- | --- |
| `config` | resolve and validate config, print result |
| `init <issue>` | scaffold `<orchestration>/<issue>/` |
| `render <template> --data f.json` | fill a template, fail on any missing field |
| `lint <prompt.md>` | size budget, unresolved placeholders, required sections |
| `plan <plan.json>` | validate story graph, emit waves, flag file overlap |
| `claim <issue>` | claim protocol, earliest claim wins |
| `status [--refresh]` | rebuild the board in `status.md` |
| `report-check <report.json>` | enforce the final-report contract |
| `telemetry --claude <log> --merge <report>` | machine telemetry into the report |
| `ledger add <report>` | append to `ledger.jsonl` |
| `costs` | rollup and budget guard (unknown is not zero) |
| `index [--sql ...]` | rebuild or query the SQLite index |
| `pricing` | rate file age, fails when stale |

## Files per story: `<orchestration>/<issue>/`
`requirements.md` `prompt.md` `diff.diff` `review.md` `final-report.json` `status.json`. Ledger: `<orchestration>/ledger.jsonl`.

## Load order
Orchestrator: this file, `roles/orchestrator.md`, config. Worker: this file, `roles/worker.md`, its prompt. Everything else on demand.
