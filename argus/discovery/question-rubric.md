# Question rubric

Decides whether to ask, what to ask, and when to stop. Goal: the fewest questions that make the story buildable.

## Step 1: try to answer it yourself
Before any question, search in this order and stop at the first hit:
1. Standing policies in config (`policies`). A hit is final.
2. The issue body, linked issues, and prior `requirements.md` files.
3. The product facts file (`facts_path`) and repo docs.
4. The code: existing behavior, roles, permission checks, tests.

If found, record the answer and its source. Do not ask.

## Step 2: classify what remains
Ask only about these three kinds of gap:

| Kind | Test | Example form |
| --- | --- | --- |
| **Gap** | A Definition of Ready gate has no answer anywhere | "Which roles can approve this?" |
| **Conflict** | The request contradicts existing behavior or a policy | "Today X does A. This story implies B. Which wins?" |
| **Edge case** | The code shows a branch the request ignores | "What happens when the list is empty / user lacks the role / input is duplicate?" |

Never ask about: implementation choices, naming, anything a standing policy answers, anything you can decide reversibly and flag.

## Step 3: shape the round
- One message per round. Number the questions.
- Each question: one line of context, the question, your proposed default.
- Make answering cheap: the human can reply "defaults" or give one-word answers.
- Maximum 5 questions per round. Rank by cost of a wrong guess, drop the rest.
- Reversible, low-cost unknowns: pick the default, record it under `assumptions`, do not ask.

## Step 4: cap
`limits.discovery_rounds` rounds (default 2). After the last round:
- Gate fully answered: `ready: true`.
- Gaps remain: `ready: false`. List the open gaps. Stop. Only a human override moves it forward.

## Step 5: record
Write answers into `requirements.md` as they arrive, each with its source (`policy`, `repo`, `human`, `default`). A new standing answer that will recur: offer once to add it to config `policies`.
