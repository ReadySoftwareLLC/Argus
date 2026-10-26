# Definition of Ready

A story is ready for a worker prompt only when every line below is answered with a concrete value in `requirements.md`. "TBD", "standard", and "as usual" do not count.

| # | Gate | Passes when |
| --- | --- | --- |
| 1 | **Who** | Named user type(s) who use it, and the situation they use it in |
| 2 | **Device** | Where it runs: devices, screen classes, or runtime (CLI, service, batch). N/A allowed for non-UI work, stated explicitly |
| 3 | **Roles** | Which roles can see it, which can act on it, which are blocked. "Everyone" must be stated, not implied |
| 4 | **Done** | Observable acceptance criteria. Each one is testable by a person or a test without asking the author |
| 5 | **Out of scope** | At least one explicit exclusion, or the statement "nothing adjacent is excluded" |

## How to evaluate
1. Fill each gate from the repo, the issue, config policies, and prior requirements. Mark the source.
2. A gate answered by a standing policy is passed. Cite the policy name.
3. A gate with no answer, or an answer that conflicts with existing behavior, is a gap. Gaps go to the question rubric.
4. Re-evaluate after each round of answers.

## Result
Write the verdict at the top of `requirements.md`:

`ready: true|false`, then per gate `pass | gap | override`, with source.

## Override
Only the human can override a gate. Record `override: <gate> by <who>: <their words>`. An override never removes the gate from the file. The worker prompt then states the assumption as a risk.

## Not part of this gate
Implementation approach, file layout, estimates. Those belong to the worker.
