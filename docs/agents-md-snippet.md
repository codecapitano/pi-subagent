# AGENTS.md snippet

The extension already tells the model which agents exist and how to delegate well.
Add routing rules of your own to `~/.pi/agent/AGENTS.md` only when you want to steer
which agent handles which job. Copy and adjust:

```markdown
## Subagents

Use the `subagent` tool for self-contained work. Keep trivial work in the parent.
Route by role:

- `scout`: external documentation and dependency research.
- `explorer`: read-only discovery in this codebase.
- `planner`: only when a separate planning pass is justified.
- `implementer`: scoped changes that need judgment. Give it owned files.
- `reviewer`: second opinion on risky or finished work.
- `verifier`: run the exact checks you specify and report the evidence.

Give each subagent a closed brief with scope, constraints, owned files and the exact
return shape. Run independent read-only tasks in one parallel call. Never let parallel
tasks edit the same files. Before declaring success, inspect the combined diff and
check the acceptance criteria yourself.
```
