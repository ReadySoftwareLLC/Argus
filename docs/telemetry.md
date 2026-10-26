# Telemetry, cost and the ledger

All numbers are machine-sourced, labeled self-reported, or null with a reason. Nothing is estimated and presented as fact.

## Flow
```
worker session log ──argus telemetry──> final-report.json (telemetry block)
                                              │ argus ledger add
                                              v
                        <orchestration>/ledger.jsonl   (append-only, committed, source of truth)
                                              │ argus index
                                              v
                        <orchestration>/.argus/index.sqlite  (derived, gitignored, rebuildable)
```
`argus costs` rolls the ledger up and runs the budget guard. `argus index --sql "SELECT ..."` runs read-only queries, for example failure rate by template version.

## Claude Code parser: what was observed
Verified against a real transcript, not assumed.

| Fact | Handling |
| --- | --- |
| An API message is written as one row per content block, all with the same `message.id` and usage | Dedupe by id, keep the row with the most output tokens |
| Some rows carry null or all-zero usage | Ignored. A model that only appears with zero usage is listed under `models_zero_usage`, not `model` |
| Cache writes are split into 5-minute and 1-hour tiers with different prices | Priced per tier. A write with no split is left unpriced, not guessed |
| `cost-state` rows hold Claude Code's own cumulative cost, tokens, duration and per-model usage | Used for `cost`, `tokens_*`, `duration_seconds` |
| `cost-state` is a periodic snapshot. Rows written after it are not in its totals | Reported in `extras.after_last_cost_state` and as a `note` on the affected fields |
| Transcript rows before a snapshot do not sum to the snapshot's token totals | Both are reported in `extras.reconciliation`. The cause is not known and is not guessed |
| Thinking tokens are inside `output_tokens` | Not billed twice |

## Pricing
`pricing/anthropic.json` holds rates per million tokens with a source URL and retrieval date. Rate entries may carry `effective_from`; the entry in effect at a message's timestamp is used. Entries with no date are the baseline.

**Drift check.** `argus telemetry` recomputes each model's cost from Claude Code's own aggregated token counts and compares it with Claude Code's reported cost (`extras.pricing_verification`). On the real transcript used to build this, `claude-sonnet-5-5` matched to within floating-point error. A mismatch means the rate file is stale or wrong. Models with prompt-size tiers cannot be checked this way and report `ok: null`.

**Refresh.** `argus pricing` fails when the file is older than `--max-age-days` (default 30). To refresh, re-fetch the source URL, update the file, and run `argus telemetry` on any recent transcript to confirm the check passes. A scheduled workflow for this is not built yet.

**Not priced, on purpose.** Unknown model ids, non-standard speed modes (fast mode), unrecognized `inference_geo` values, and batch usage return null with a reason. Add them to the rate file when they are real.

**Units.** Claude cost is `usd_api_equivalent`. A subscription is not billed per token, so this is what the usage would cost at API rates. Copilot reports credits, which are never converted to dollars.

## Cost accuracy rules
- A cost with a `note` is a lower bound. `argus costs` counts it and lists it under `partial_cost_stories`.
- Unknown cost is never zero. It appears under `unknown_cost_stories`.
- The budget guard halts when known cost reaches `limits.epic_budget_usd`. It also reports when the total is incomplete.
- The latest report per issue supersedes earlier ones.

## Ledger events
`story_finished`: issue, outcome, review verdict, PR number, template name and version (read from the `argus-template` marker in the story's `prompt.md`), and the full telemetry block with provenance. Appends are idempotent per (issue, report hash).

## Known gaps
- **Copilot:** no parser. `argus telemetry --host copilot` returns every field null with that reason. It needs a real session-log sample, since the format was not guessed.
- **Sub-agent cost:** reviewer sub-agents may log elsewhere. Not verified whether their usage is inside the worker's `cost-state`.
- **Duration:** taken from `totalDuration` as Claude Code reports it.
