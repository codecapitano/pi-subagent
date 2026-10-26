# AGENTS.md snippet

The extension already lists the agents and tells the model how to delegate: when,
how to write the brief, parallel limits and checking results. Add to
`~/.pi/agent/AGENTS.md` only policy that is specific to you. Examples to adapt:

```markdown
## Subagents

- Run `reviewer` before declaring done on changes to auth, billing or migrations.
- Use `verifier` for the full test suite; run single-command checks yourself.
- Use `advisor` before any change to a public API.
```
