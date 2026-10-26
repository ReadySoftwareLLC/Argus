---
name: argus-onboarding
description: Set up Argus in a repo or solution. Use when a repo has no argus.config.json, or the user asks to adopt Argus.
---

# Onboard a repo to Argus

Goal: a valid `argus.config.json`, vendored `argus/`, labels in the tracker. Ask the human only what the repo cannot answer. Never fill a field by guessing.

## 1. Check
- Node 22.13 or later: `node -v`
- `gh auth status` succeeds
- Current directory is the anchor repo root

## 2. Vendor
If `argus/` is missing: `node <argus checkout>/argus/tools/argus.mjs sync --from <git url> --ref <tag>`

## 3. Ask once, in one batch, only what is missing
- Product name
- Tracker repo (`owner/name`), only if the anchor has no GitHub remote
- Other repos in the solution as `key=path` (UI, service, database)
- Budget cap in USD, or none
Do not ask about test commands, branches or remotes: they are detected, or left unset.

## 4. Write the config
Preview: `node argus/tools/argus.mjs onboard --name "<name>" [--tracker o/r] [--also api=../api] --dry-run`
Read `evidence` (where each value came from) and `unset` (what was not found). Then run it without `--dry-run`, adding `--labels` to create the state labels.

## 5. Fill the gaps the human states
Edit `argus.config.json` for: `repos.*.test_command` where listed in `unset`, `product.facts_path`, `limits.epic_budget_usd`, and each standing policy the human gives you (`discovery/standing-policies.md`). One policy per entry. Do not invent any.

## 6. Verify
- `argus config` passes
- `argus sync --verify` passes
- `argus init <first issue>` scaffolds the first story

## 7. Hand back
Commit `argus/`, `argus.lock`, `argus.config.json`, `orchestration/`. Tell the human which `unset` items remain.
