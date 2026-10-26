# Adapter: any other agent host

Argus has no host dependency beyond three capabilities. A host that has them can run Argus as is.

| Capability | Used for | If missing |
| --- | --- | --- |
| Read and write files | all artifacts | cannot run Argus |
| Run shell commands | `argus` CLI, `gh`, tests | cannot run Argus |
| Spawn a separate agent with its own context | worker dispatch, reviewer dispatch | workers: manual mode. Reviewer: **halt** |

## Wiring
1. Load `argus/quickref.md` and the role file for the session type.
2. Give the worker one instruction: read its prompt file and follow it.
3. Give the reviewer one instruction: read its rendered review task and follow it.

Do not inline another agent's prompt into the current session. That produces a paraphrase that drifts from the real review.

## Writing a new adapter
Add `adapters/<host>/README.md` covering: how to start each role, how to spawn a separate agent, how to read the session log for telemetry (v0.2). Keep it under one page. No product facts.
