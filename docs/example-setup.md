# Example setup

This page shows one way to run pi-subagent on a real machine: which role gets which
kind of model, why, and how to reproduce it on another machine. Model IDs depend on
your providers, so the tables use placeholders. Replace them with models you have.

## Configuration

Agent definitions live in `~/.pi/agent/agents/*.md`. Each file holds a prompt, a tool
allowlist and, optionally, one frontmatter line that pins a model:

```yaml
model: <provider>/<model>:<effort>
```

There are seven definitions: the six starters in [`agents/`](../agents/) and the
optional `design-reviewer` in [`agents/optional/`](../agents/optional/). The starters
do not pin a model. They inherit the model and effort of the parent session. This
setup pins one per role:

| Agent (file name) | Model tier | Effort |
| --- | --- | --- |
| `implementer` | strong | medium |
| `advisor` | strong | high |
| `reviewer` | strong | medium |
| `design-reviewer` | strong, with image input | medium |
| `explorer` | cheap | medium |
| `scout` | cheap | medium |
| `verifier` | cheap | low |

Use the full, versioned model ID in each line. A short or fuzzy name can match a
different model than you expect. The assignments set the helpers only. They do not
change the parent session's model.

## Why these assignments

- A cheap model handles discovery, research, mechanical edits and prescribed checks.
  The output of `explorer` and `scout` is cited evidence that the parent can verify.
- A strong model at medium effort implements. The advisor gets one consultation per
  run and sees only the implementer's brief, so a weak implementer cannot be rescued
  by a strong advisor. The same tier reviews code and designs. Design review needs a
  model that accepts images.
- The advisor runs at high effort. It runs at most once per implementer, so the extra
  reasoning cost is bounded. The parent owns task decomposition and final decisions.

Effort levels are defaults per role. They are not automatic routing by difficulty. The
extension does not accept a model or effort per dispatch. Speed and cost depend on
context size, reasoning tokens, tool calls, retries and your authentication plan.
Catalog token prices do not necessarily describe subscription billing.

## Reproduce on another machine

1. Install Pi and authenticate the providers you want to use, for example with `/login`.
2. Install the extension with one method only, as described in the
   [README](../README.md#install). Loading it twice can register the tool twice.
3. Copy the starter agents without overwriting your own files:

   ```sh
   mkdir -p ~/.pi/agent/agents && cp -n agents/*.md ~/.pi/agent/agents/
   ```

   Copy `agents/optional/design-reviewer.md` too if you want it. Back up any existing
   agent files first. To move a customized setup between machines, copy the Markdown
   definitions themselves, not only the table, so prompts and tool restrictions are kept.
   Never move credentials through a repository or a document.
4. Add a `model:` line to each file you want to pin, using the table above.
5. Merge any routing rules you want into `~/.pi/agent/AGENTS.md`. The tool already
   carries its own guidance. See [`agents-md-snippet.md`](agents-md-snippet.md) for
   examples. Do not overwrite unrelated instructions.
6. For `design-reviewer`, configure the Chrome DevTools and Figma MCP servers and
   `codemode`. For `scout`, make sure web research tools are available. An agent
   definition does not install these integrations.
7. Run `pi --list-models` and confirm that every model you pinned is listed.
8. Run `/reload` while Pi is idle, or restart Pi. Check the agent roster in the tool
   description, and try a small task before relying on the setup.

## Repository versus personal setup

The repository starters intentionally omit model assignments, and
`starter-agents.test.mjs` enforces that. The installer updates the extension runtime,
not `~/.pi/agent/agents/`, and package installation also leaves agent definitions to
you. Changing a model assignment therefore needs no repository change.
