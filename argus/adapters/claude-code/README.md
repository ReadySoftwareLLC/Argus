# Adapter: Claude Code

Argus templates are host-neutral. This file says how to map them onto Claude Code.

## Orchestrator session
Start a session in the anchor repo and give it: `argus/quickref.md`, `argus/roles/orchestrator.md`. Nothing else is preloaded.

## Dispatching a worker
Preferred: a subagent call (Agent/Task tool) with the prompt:

`Read <story_dir>/prompt.md and follow it exactly.`

Fallback when subagents are unavailable: a headless session, one per story:

`claude -p "Read <story_dir>/prompt.md and follow it exactly." --model <models.worker>`

Pass `models.worker` from config when set. Run each in its own git worktree.

## Dispatching the reviewer
The worker dispatches the reviewer with a subagent call whose prompt is:

`Read <story_dir>/review-task.md and follow it exactly.`

where `review-task.md` is `templates/code-review.md` rendered with `argus render`. The reviewer is a separate agent with its own context. If the worker cannot make a subagent call, it halts. It must not read the review template and act as the reviewer itself.

## Concurrency
Concurrent stories come from `argus plan`. Never dispatch more than `limits.max_concurrent` at once. One worktree per worker.

## Manual mode
When `host.dispatch` is `manual`, run `argus plan <plan.json> --launch`, show the output to the human, and stop. The human opens the sessions.

## Telemetry source
Claude Code writes the session log to `~/.claude/projects/<cwd with / replaced by ->/<session-id>.jsonl` (observed: cwd `/home/claude` gives `-home-claude`). The worker passes that path to `argus telemetry --claude`. The log contains Claude Code's own `cost-state` snapshots, which `argus` uses for cost and token totals.
