# Final report contract

Every worker writes `<orchestration>/<issue>/final-report.json`. Enforce with `argus report-check`. A later report supersedes an earlier one: write `final-report.<n>.json` and keep the old file, do not overwrite.

## Rule for every telemetry field
A field is one of exactly three shapes:

| Shape | JSON |
| --- | --- |
| Machine-sourced | `{ "value": <v>, "source": "machine", "tool": "<name>", "note": "<optional>" }` |
| Self-reported | `{ "value": <v>, "source": "self_reported" }` |
| Unknown | `{ "value": null, "reason": "<why it cannot be observed>" }` |

Anything else fails the check. A missing field fails. A guessed number labeled `machine` is a contract violation.

`value` may be an array when several values were observed (for example `model` when a session switched models). A `note` marks a value as partial or qualified. Rollups count a noted cost but flag it as a lower bound.

## Required top-level keys
| Key | Type | Notes |
| --- | --- | --- |
| `contract_version` | `1` | |
| `issue` | string | e.g. `"42"` |
| `outcome` | `done` / `blocked` / `halted` | |
| `pr` | object | `url`, `number`. Required when `outcome` is `done`, otherwise may be `null` with `pr_reason` |
| `criteria` | array | `{ criterion, status: met/unmet/unverifiable, evidence }` per acceptance criterion |
| `review` | object | `dispatched` (bool), `verdict`, `path`. `dispatched: false` forces `outcome` to `halted` or `blocked` |
| `telemetry` | object | see below |
| `tangents` | array of strings | what went to the parking list |
| `blocked_reason` | string | required when `outcome` is `blocked` or `halted` |

## Telemetry keys (each uses the three-shape rule)
`model`, `reasoning_effort`, `duration_seconds`, `tests_passed`, `tests_failed`, `tokens_input`, `tokens_output`, `tokens_cache_read`, `tokens_cache_write`, `cost`, `cost_unit`, `files_changed`, `lines_added`, `lines_removed`.

Guidance:
- `files_changed`, `lines_*`: `--numstat <file>` from `git diff --numstat`, machine.
- `tests_*`: `--junit <file>` from the test runner's junit.xml, machine.
- `tokens_*`, `cost`, `duration_seconds`, `model`, `reasoning_effort`: `argus telemetry --claude <session-log> --merge <final-report.json>`. No parser for the host (Copilot today): `null` with a reason.
- Run `argus telemetry` as the last step, after the final tool call, so the cost snapshot is as current as possible. Any gap is reported in the field `note`.
- `cost_unit`: `usd_api_equivalent` or `credits`. Credits are never converted to dollars.
- `model`, `reasoning_effort`: machine if read from the session log, otherwise `self_reported`. Never a guess.

## Pass condition
All required keys present, all telemetry keys in a valid shape, `outcome` consistent with `review` and `pr`.
