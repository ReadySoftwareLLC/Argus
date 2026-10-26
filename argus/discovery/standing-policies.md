# Standing policies

Answers the agent must never re-ask. Argus ships none. Each consuming repo declares its own in `argus.config.json` under `policies`.

## Shape
```json
"policies": {
  "money-display": {
    "answer": "Show currency with two decimals and the account's currency code.",
    "applies_to": ["ui", "report"],
    "source": "docs/policies.md#money"
  },
  "audit-trail": {
    "file": "docs/policies/audit.md"
  }
}
```

| Field | Meaning |
| --- | --- |
| `answer` | Short answer, inline. Use for one or two sentences |
| `file` | Path to a longer policy, relative to the config file. Use when it will not fit inline |
| `applies_to` | Optional tags matched against the story's `tags`. Omit to apply to every story |
| `source` | Optional pointer for humans to the origin of the decision |

Exactly one of `answer` or `file` is required. The CLI rejects both or neither.

## How the agent uses them
1. At discovery start, load all policies (`argus config --policies`). Inline answers are loaded in full. File policies are loaded only when their tags match or a gate needs them.
2. A gate answered by a policy is marked `pass (policy: <name>)`. No question is asked.
3. The worker prompt lists applicable policies by name with their answer or path.
4. A story that conflicts with a policy is a **conflict** in the rubric. Ask the human which wins, and do not edit the policy yourself.

## Adding one
When the human gives an answer that will recur, offer once: "Add as standing policy `<name>`?" On yes, propose the JSON entry for the human to commit. Do not write config silently.

## Keep small
Policies are for decisions, not documentation. If an entry needs more than a short paragraph, point to a `file`.
