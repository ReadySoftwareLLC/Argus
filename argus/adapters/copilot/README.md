# Adapter: GitHub Copilot CLI

Argus templates are host-neutral. This file says how to map them onto the Copilot CLI.

## Sessions
Start an orchestrator or worker session in the repo and give it `argus/quickref.md` plus the role file. A worker reads its prompt file and follows it, same as any host. Spawning a separate reviewer needs a real sub-agent call; if the CLI session cannot make one, the worker halts.

## Telemetry source
The CLI writes `~/.copilot/session-state/<session-id>/events.jsonl`. The worker passes that path:

`argus telemetry --host copilot --log <events.jsonl> --numstat <f> --junit <f> --merge <final-report.json>`

Cost comes back as `aiu`, never dollars. Token counts match Claude's meaning: `tokens_input` is uncached input. Details and limits are in `docs/telemetry.md`. VS Code Copilot Chat logs (`chatSessions`) are a different format and are not parsed.
