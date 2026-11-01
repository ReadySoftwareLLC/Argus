# Adapter: Claude Code

Argus templates are host-neutral. This file says how to map them onto Claude Code.

## Orchestrator session
Start a session in the anchor repo and give it: `argus/quickref.md`, `argus/roles/orchestrator.md`. Nothing else is preloaded.

## Dispatching a worker
Used when `host.dispatch` is `claude-code`. `argus plan --manual` overrides it for one run and prints the manual launch plan instead.

Preferred: a subagent call (Agent/Task tool) with the prompt:

`Read <story_dir>/prompt.md and follow it exactly.`

Fallback when subagents are unavailable: a headless session, one per story:

`claude -p "Read <story_dir>/prompt.md and follow it exactly." --model <models.worker>`

Pass `models.worker` from config when set. Run each in its own git worktree.

## Dispatching the reviewer
Nesting is supported: a worker started as a subagent can itself call the Agent tool. Per the [Claude Code sub-agents docs](https://code.claude.com/docs/en/sub-agents), a subagent can spawn subagents by default, up to three layers below the main conversation (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` changes the limit; `1` turns nesting off). Orchestrator -> worker -> reviewer is two layers. Keep `Agent` in the worker's tool list, and do not set the depth below 2.

The worker dispatches the reviewer with a subagent call whose prompt is:

`Read <story_dir>/review-task.md and follow it exactly.`

where `review-task.md` is `templates/code-review.md` rendered with `argus render`. The reviewer is a separate agent with its own context. If the worker cannot make a subagent call, it halts. It must not read the review template and act as the reviewer itself.

## Concurrency
Concurrent stories come from `argus plan`. Never dispatch more than `limits.max_concurrent` at once (default 4). One worktree per worker.

Each worker may also run a reviewer agent, so actual concurrent agents can be up to 2x the limit (default 4 -> up to 8). `argus` warns when `max_concurrent` is above 6. Claude Code has its own cap, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`.

## Manual mode
When `host.dispatch` is `manual` (the default when onboarding without `--dispatch`), run `argus plan <plan.json> --launch`, show the output to the human, and stop. To force this for a single run when config says `claude-code`, run `argus plan <plan.json> --manual` instead. The output's first line names the mode and why. The human opens the sessions.

## Telemetry source
Claude Code writes the session log to `~/.claude/projects/<cwd with / replaced by ->/<session-id>.jsonl` (observed: cwd `/home/claude` gives `-home-claude`). The worker passes that path to `argus telemetry --claude`. The log contains Claude Code's own `cost-state` snapshots, which `argus` uses for cost and token totals.

## Onboarding skill
`argus/skills/onboarding/SKILL.md` is plain markdown any agent can follow. To have Claude Code discover it as a skill, copy the folder to `.claude/skills/argus-onboarding/` in the consuming repo.
