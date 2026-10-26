# AGENTS.md snippet

The extension already tells the model which agents exist and how to delegate well.
Add routing rules of your own to `~/.pi/agent/AGENTS.md` only when you want to steer
which agent handles which job. Copy and adjust:

```markdown
## Subagents

Route by role:

- `scout`: external documentation and dependency research.
- `explorer`: read-only discovery when it would meaningfully burden the parent, not a prerequisite to implementation.
- `advisor`: consequential technical questions, or a substantial plan when explicitly needed.
- `implementer`: bounded changes with local judgment. Give it owned files and acceptance criteria.
  It may use `consult_advisor` once before a consequential uncertain approach or
  when investigation stops converging; it does not delegate implementation.
- `reviewer`: independent review when requested or warranted by the change's risk.
- `transformer`: fully specified mechanical changes with mechanically verifiable output.
- `verifier`: run prescribed checks when separate execution helps. Implementers run
  their own acceptance checks; do not duplicate completed checks without a reason.

Never let parallel tasks edit the same files. Before declaring success, inspect the
combined diff and check the acceptance criteria yourself. Do not run a mandatory
planning or review pipeline for modest tasks. Keep stronger models for uncertainty or
consequential review, and escalate unresolved worker questions to the parent.
```
