<!-- argus-template: worker-prompt v1 -->
# Worker task: {{issue}} {{title}}

Role file: `{{argus_dir}}/roles/worker.md`. Read it first. This prompt is self-contained: do not rely on any chat history.

## Story
Issue: {{issue_url}}
Repo: {{repo}} (path `{{repo_path}}`)
Branch: `{{branch}}`
Requirements: `{{requirements_path}}`

{{summary}}

## Acceptance criteria
{{acceptance_criteria}}

## Out of scope
{{out_of_scope}}

## Rules to apply
Read and cite each of these in your self-review, with file evidence:
{{rules}}

## Standing policies
Already decided. Do not ask or revisit:
{{policies}}

## Commands
Test: `{{test_command}}`

## Artifacts
Write to `{{story_dir}}/`: `diff.diff`, `review.md`, `final-report.json`. Append tangents to `{{parking_list}}`.

## Review
Dispatch a real sub-agent with `{{argus_dir}}/templates/code-review.md`. If you cannot dispatch, halt and write a blocked report.

## Stop condition
Open the PR and write a passing final report. Do not merge.
