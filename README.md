# pi-subagent

Parallel subagents for the [Pi coding agent](https://github.com/earendil-works/pi).
Pi can hand focused tasks to helper agents. Each helper runs in its own process
with a fresh context and returns a short result.

## Why use subagents

- **A clean main context.** Searching, reading many files and running noisy
  checks happen in the helper. Your main session receives the conclusion, not the
  transcript.
- **Speed for independent work.** Tasks that do not depend on each other run at
  the same time.
- **The right model per role.** Each agent definition sets its own model and tool
  allowlist, so cheap models can do lookups and strong models can advise.

Subagents use more tokens in total, and the parent waits until a batch finishes.
There are no background jobs. Use them when work splits into independent parts, or
when the output is much larger than its conclusion. A helper only knows what its
brief says, so the parent should check its results. Tool allowlists limit what an
agent can call. They are not a sandbox.

## Tool surface

One tool, `subagent`:

- Single: `{ agent, task, cwd? }`
- Parallel: `{ tasks: [{ agent, task, cwd? }, ...] }`, at most 8 tasks.

Every task has its own result, status and optional working directory. Results keep
input order, and one failed task does not lose the others. Model-facing output is
bounded (see [Output limits](#output-limits)).

A shared FIFO limiter keeps active helpers bounded across all calls in one Pi
runtime. The default is 4. Set `PI_SUBAGENT_MAX_CONCURRENCY` before starting Pi to
change it. Values are clamped to 1 through 16, and an unset or non-numeric value
uses the default. The limit is per Pi runtime, not machine-wide.

## Nesting depth

The extension sets `PI_SUBAGENT_DEPTH` for every child (the parent's depth plus one;
unset means 0).

- **Depth 0** (your session): all roles are available.
- **Depth 1** (a child): the `subagent` tool exists only if the role lists `subagent`
  in its `tools`. It accepts only read-only roles: roles whose `tools` contain none
  of `edit`, `write` or `subagent`. Bash is allowed, because the advisor uses
  read-only bash by prompt. A call that names any other role is refused before
  anything starts.
- **Depth 2 or more**: the tool refuses with an error.

So a child can ask the advisor or the explorer, but cannot start editors or deeper
nesting. The depth is read when the extension loads.

## Install

You need an existing Pi installation. Pick one method, not both: loading the
extension twice can register the tool twice.

### Pi package (recommended)

```sh
pi install git:github.com/codecapitano/pi-subagent@v0.4.0
```

The tag pins the version. Update by installing a newer tag. This loads `index.ts`
straight from the package. Remove it with
`pi remove git:github.com/codecapitano/pi-subagent`. Packages run code, so read the
source first. It is four files, and the roles are plain Markdown.

The package does not install roles. Copy them yourself (see [Roles](#roles)).

### Manual copy

```sh
mkdir -p ~/.pi/agent/extensions/subagent
cp index.ts agents.ts lifecycle.mjs output.mjs ~/.pi/agent/extensions/subagent/
```

`node scripts/install.mjs` does the same copy with safety checks: it refuses
symlinks, stages the files, and backs up replaced files under
`~/.pi/agent/backups/` (override with `PI_SUBAGENT_BACKUP_DIR`). It never touches
`~/.pi/agent/agents/`. Pass a folder to install somewhere else.

### Check the install

Run `/reload` while Pi is idle, or restart Pi. The loaded extension does not change
when files on disk change. Then check that the `subagent` tool is listed and that its
description names your roles.

## Roles

Roles are Markdown files in `~/.pi/agent/agents/`. Every role needs `name`,
`description` and a non-empty `tools` list. Quote a description that contains a
colon. Only user-level roles are read. The roster is built when the extension
loads, so run `/reload` after changing roles.

If a role file is skipped (invalid frontmatter, or a missing name, description or
tools), the tool description ends with a line such as
`Skipped agent files: explorer.md (invalid frontmatter).` Nothing throws, and the
other roles keep working.

[`agents/`](agents/) ships three starters:

| Role | Tools | Use |
| --- | --- | --- |
| `explorer` | read, grep, find, ls, web_search, web_fetch | Local search and external documentation lookups |
| `implementer` | read, edit, write, bash, grep, find, ls, subagent | A scoped change with its own checks. May ask the advisor once for a hard decision and the explorer for lookups. Cannot delegate edits |
| `advisor` | read, grep, find, ls, bash | Hard decisions, and review shards on large diffs. Runs only read-only commands |

`web_search` and `web_fetch` come from a separate Pi search package, not from this
extension. Without one installed, the explorer is local-only.

Copy the starters without overwriting your own files:

```sh
mkdir -p ~/.pi/agent/agents && cp -n agents/*.md ~/.pi/agent/agents/
```

More roles (`reviewer`, `scout`, `verifier`, `design-reviewer`) are in
[`agents/optional/`](agents/optional/).

The starters do not pin a model, so each helper uses the parent's model. To route a
role to another model, add `model: <provider>/<model>[:thinking]` to its frontmatter.

## Prompt guidance

The tool lists your roles in its own description and registers its own
`promptSnippet` and `promptGuidelines`, so no `AGENTS.md` entry is needed. The
guidelines cover when to delegate, the brief, parallel work without overlapping
files, multi-lane edits, review, and verifying results. They depend on depth: a
child is told to ask the advisor once for a hard decision and the explorer for
lookups, and that it cannot delegate edits. For personal policy, see
[`docs/agents-md-snippet.md`](docs/agents-md-snippet.md).

## Output limits

Retained output is bounded per task:

| Output | Limit |
| --- | --- |
| Serialized rolling message history | 1 MiB |
| Latest assistant text preview | 64 KiB |
| Provider error text preview | 64 KiB |
| stderr tail | 64 KiB |
| One stdout JSON line, including an unfinished line | 8 MiB |
| Model-facing result text | 16 KiB |

Parallel model-facing text has a 128 KiB total budget, including headers. Short
results leave more room for longer ones. History eviction is recorded in each
result's `output` metadata, and usage totals still count all messages. A stdout
line over the limit fails the task and stops the child.

## Cancellation and shutdown

Cancelled queued tasks never start. Top-level children (depth 0) are spawned
detached, so each leads its own process group. On cancel, the group gets SIGTERM,
then SIGKILL after five seconds, so grandchildren cannot outlive it. Nested
children are not detached and stay in their parent's group. If the group is already
gone, the signal falls back to the child's pid. Slots stay occupied until the child
closes.

Pi awaits the shutdown handler on reload, session replacement and quit. It aborts
queued work and waits for active children to stop. There is no automatic task
timeout. A hung child holds a slot until cancelled. A descendant that left the
process group can still outlive the cancel.

## Verification

```sh
npm test
```

The tests cover the limiter, depth rules, role filtering, cancellation (including a
process-tree test with real processes), output bounds, rendering, the installer, and
Pi extension loading with fake child processes. They make no model calls. They need
a Pi installation: they read it from `~/.pi/agent/install`, or from `PI_CORE_DIR`
(the `@earendil-works/pi-coding-agent` package directory). Developed against Pi 1.2
and 1.3.

## Status and known limitations

- **Roles are not bundled automatically.** Copy them yourself.
- **No background jobs.** The parent waits for the whole batch.
- **Unverified in practice.** The tests use fake child processes. Real provider
  rate limits and throughput have not been measured.

## Credits and license

Derived from the subagent example in the
[Pi repository](https://github.com/earendil-works/pi), which is MIT licensed.
This project is released under the [MIT License](LICENSE).
