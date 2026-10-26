# Pre-generation checklist

Run before writing any worker prompt. Every item is yes or stop.

1. **Live state.** Issue re-fetched this session. Open, `argus:ready`, unclaimed, no open PR already linked.
2. **Dependencies.** Every `depends_on` issue is closed or its PR merged. Verified live, not from `status.md`.
3. **Definition of Ready.** Passed, or the human override is recorded in `requirements.md`.
4. **Requirements file.** `requirements.md` exists, has acceptance criteria and an out-of-scope list, and has no unresolved `[?]` markers.
5. **Standing policies.** Every policy in config relevant to this story is listed in the prompt. None re-asked.
6. **Rules injected.** The prompt names each applicable rules file path from `repos.<name>.rules_path`. Naming the directory is not enough.
7. **Test command.** Taken from `repos.<name>.test_command`. If absent, ask once. Never assume one.
8. **Overlap.** `argus plan` shows no unresolved file overlap with any story that runs concurrently.
9. **Budget.** Epic cost is under `limits.epic_budget_usd`, or the budget is unset. Unknown cost is reported, not treated as zero.
10. **Prompt lint.** `argus lint` passes: within size budget, no unresolved placeholders, all required sections present.
