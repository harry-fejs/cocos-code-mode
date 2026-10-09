# Prompt Guidance — Risks & Trade-offs

Applies to: `README.md` → Agent Prompt Guidance snippet for the selected `ccp3x_<port>` manual.

## The snippet

```text
When returning data from CCP 3x tools (manual `ccp3x_<port>`):
- Return stats/aggregates (counts, top-N) unless the question needs items.
- User asks list/find/which/show → return capped list with .slice(0, N), not count.
- Drop empty arrays/objects and deep subtrees a summary already answers.
- Keep reference/id for any node you may operate on in a next step (verbs: set/add/remove/destroy).
- If an aggregate looks anomalous (large branch, mixed active, errors), drill into that branch before concluding.
```

## Failure modes

### 1. Lost reference when mutation follows aggregation — highest risk

Prompt says "keep reference/id only if next step needs it" → agent must predict chain.

- Fail: turn 1 aggregates, turn 2 wants `inspectorSet` (was `inspectorSetInstanceProperties`) but has no `uuid` → extra round-trip to re-fetch tree.
- Impact: +1 hop, ~0.5k tok. Still cheaper than retaining raw tree (~3k).
- Mitigation in snippet: explicit verb list, keep on any planned mutate.

### 2. Summary hides the item the question needs — medium risk

`stats/top-N` + `.slice(0, N)` can miss the target at position N+1 for exploratory queries ("which node has wrong scale?").

- Mitigation: second rule — `list/find/which/show` questions bypass aggregation.

### 3. Dropped defaults misinterpreted — low risk after fix

Early draft suggested dropping `active:true` with convention "missing = true". After `/compact` the agent forgets the convention.

- Fixed: rule now drops only empty containers/subtrees, not semantic defaults.

### 4. Anomalous branch not drilled — low risk

"Anomalous" is subjective. Mitigation: define concrete triggers (branch > 20 children, `active:false` present, has errors).

## Net trade-off

Typically -50 to -80% response tokens. Worst case +1 re-query, still net negative. Rollback is prompt-only (remove the snippet, no code change).
