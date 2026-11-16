# AGENTS.md snippet

The extension already lists the agents and tells the model how to delegate: when,
how to write the brief, parallel limits and checking results. Add to
`~/.pi/agent/AGENTS.md` only policy that is specific to you. Keep hard decisions
with `advisor` and reviews of existing work with `reviewer`. Combined-diff review
after multiple implementer lanes is already covered by the extension guidance.
Model choices belong in your installed role files, not in this snippet.

Examples to adapt:

```markdown
## Subagents

- Use `advisor` before any change to auth, billing, migrations or a public API.
- Use `explorer` for any lookup that needs more than three files.
- Run the full test suite yourself, with output redirected to a file.
```
