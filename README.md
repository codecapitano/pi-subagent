# pi-subagent

Parallel subagents for the [Pi coding agent](https://github.com/earendil-works/pi).
Pi can hand focused tasks to helper agents. Each helper runs in its own process
with a fresh context and returns a short result.

## Why use subagents

- **A clean main context.** Searching, reading many files and running noisy
  checks happen in the helper. Your main session receives the conclusion, not the
  transcript, so it stays focused for longer.
- **Speed for independent work.** Tasks that do not depend on each other run at
  the same time. Reviewing five modules takes about as long as the slowest one.
- **Independent review and the right model per role.** A reviewer that has not
  seen your reasoning can catch what the author missed. Each agent definition sets
  its own model and tool allowlist, so cheap models can do mechanical work and
  strong models can review.

## When it is worth it

Subagents use more tokens in total, and the parent waits until a batch finishes.
This extension has no background jobs. Use them when work splits into independent
parts, or when the output is much larger than its conclusion.

A helper only knows what its brief says, and its summary can lose detail, so the
parent should check the results. Parallel helpers share one filesystem. Prefer
read-only work such as exploration and review, or give each writer separate files.
Tool allowlists limit what an agent can call. They are not a sandbox.

## What this extension adds

- Single calls and parallel batches of up to 32 tasks.
- One focused, read-only advisor consultation per worker runtime, without granting
  the worker general delegation access.
- A shared limiter keeps active helpers bounded (default 6). Extra tasks wait in
  order.
- The agent can raise the limit for one call with `maxConcurrency`, up to a
  ceiling you set (default 8). It can never go above it.
- Bounded output and per-task results, so a large batch cannot flood the parent's
  context. One failed task does not lose the others.
- Clean cancellation and shutdown. Cancelled tasks never start, and running
  helpers are stopped.

Developed and tested against Pi 1.2 and 1.3. Offline tests use fake child
processes and make no model calls.

## Install

You need an existing Pi installation. Pick one method, not both: loading the
extension twice can register the tool twice.

### Pi package (recommended)

```sh
pi install git:github.com/codecapitano/pi-subagent@v0.3.1
```

The `@v0.3.1` tag pins the version. Update by installing a newer tag. Run `/reload`
while Pi is idle, or restart Pi. This loads `index.ts` straight from the package;
it does not copy anything into `~/.pi/agent/extensions/`. Remove it with
`pi remove git:github.com/codecapitano/pi-subagent`. Packages run code, so read the
source first. It is four files, and the starter agents are plain Markdown.

The package does not install agents. Copy the starters yourself (see
[Define agents](#define-agents)).

### Manual copy

The extension is four files that Pi loads from a folder, so a plain copy also works
and can be read line by line. Run these commands from this directory:

```sh
mkdir -p ~/.pi/agent/extensions/subagent
cp index.ts agents.ts lifecycle.mjs output.mjs ~/.pi/agent/extensions/subagent/
```

Then run `/reload` while Pi is idle, or restart Pi. The loaded extension does not
change when files on disk change.

### Optional: installer script (manual copy)

`node scripts/install.mjs` does the same copy with a few safety checks. It has no
dependencies and makes no network calls. In order, it:

1. Refuses to continue if the destination or any file it would replace is a symlink,
   or if the destination is this source directory.
2. Copies the files into a hidden staging folder inside the destination.
3. Copies any existing versions of those files to a new folder under
   `~/.pi/agent/backups/` and prints its path.
4. Renames the staged files into place. Each file swap is atomic, but the whole
   install is not one transaction. If it stops partway, restore the printed backup
   or run it again.

It installs the four runtime files plus `README.md`, `LICENSE` and the offline tests.
It never touches `~/.pi/agent/agents/`, and it leaves other files in the destination
alone. To install somewhere else, pass the folder as an argument. Set
`PI_SUBAGENT_BACKUP_DIR` to move the backups.

## Prompt guidance

The tool lists your available agents (name and description) in its own description,
so the model knows which roles exist without an `AGENTS.md` roster. The list is read
when the extension loads; run `/reload` after adding or renaming an agent.

The tool also registers its own `promptSnippet` and `promptGuidelines`, which Pi adds to
the system prompt while the tool is active. Pi's model learns when to delegate, how
to write a brief and to verify results without any `AGENTS.md` entry. To change the
policy for your own setup, for example which agent to use for which job, add that to
your `AGENTS.md`.

## Define agents

Agents are Markdown files in `~/.pi/agent/agents/`. Every definition needs a
non-empty tool allowlist. Only user-level definitions are enabled; chain mode and
project-local agents are disabled.

This repository includes starter agents in [`agents/`](agents/): `scout`
(external research), `explorer` (read-only codebase discovery), `advisor`,
`implementer`, `reviewer`, `verifier` and `transformer` (mechanical changes). Copy
them without overwriting your own files:

```sh
mkdir -p ~/.pi/agent/agents && cp -n agents/*.md ~/.pi/agent/agents/
```

An optional `design-reviewer` (UI fidelity and accessibility review) is in
[`agents/optional/`](agents/optional/). It expects `codemode` and MCP servers named
`chrome_devtools` and `figma`, and its prompt tells it to report any tool it cannot
reach instead of claiming checks passed. I have not verified how Pi treats an
allowlist entry for a server that is not configured, so try it before relying on it.

For routing rules of your own, see [`docs/agents-md-snippet.md`](docs/agents-md-snippet.md).

The starters do not pin a model, so each helper uses the parent's model. Model IDs
depend on your providers. To route a role to a cheaper or stronger model, add a
line such as `model: <provider>/<model>:low` to its frontmatter. `transformer` has
a commented example.

## Advisor consultation

The `implementer` starter can make local implementation choices and call
`consult_advisor` after initial inspection, before committing to a consequential
approach with unresolved assumptions or compatibility risks, or when investigation
stops converging. It does not need an exact reference pattern. Routine choices do not need consultation;
product decisions, permissions, and scope changes go back to the parent.

`consult_advisor` takes a self-contained `task` and optional `cwd`. Include the
original objective, acceptance criteria, constraints, current changes, file evidence,
and exact failure output when applicable. State the decision needed, options, and
proposed approach. The advisor does not inherit the worker's conversation. Keep the
brief focused rather than copying the full transcript. Focused advice aims for
150–250 words or fewer when sufficient, with room for critical risks; explicitly
requested plans can be longer. This is a prompt target, not a runtime token cap.

The tool always
runs the user-level agent named `advisor`. It forces `read,grep,find,ls` and disables
MCP for that process, even if the advisor definition lists other tools. It uses the
advisor's model assignment, or inherits the caller's model and effort if unpinned.
Pin a stronger model on the advisor if you want a cheaper implementer to escalate.

Only one attempt is allowed per extension runtime, including failed or cancelled
attempts. Concurrent requests cannot spend it twice. Each worker is a fresh process,
so it gets its own attempt. In an interactive parent this allowance lasts until
runtime replacement, such as reload; the parent can use ordinary `subagent` calls
for separate advice or planning tasks. The advisor cannot call tools to edit, run
shell commands, or delegate during a consultation. This is a tool restriction, not
an operating-system sandbox; installed extensions still run with user permissions.

Consultations reuse the child runner, cancellation, output bounds, and usage
accounting. Limits remain per process: six workers consulting at once can create
six additional advisor processes. There is no machine-wide limit or automatic
consultation timeout. Existing descendant-process cleanup limitations still apply.

### Migrate existing definitions

The advisor replaces the starter planner and handles substantial planning only
when explicitly requested. Back up your definitions, copy `agents/advisor.md`, and
transfer any planner model assignment to it. Remove the old `planner.md` only after
updating your routing instructions. Copying starters with `cp -n` does not remove or
update existing definitions.

Update your implementer prompt from the starter and add `consult_advisor` to its
tool list, not `subagent`. A separate small-implementation role is optional; the
bounded implementer can cover that work too. Keep personal model assignments when
updating prompts. Install this extension version alongside the updated definitions,
then run `/reload` while idle or restart Pi. Older versions do not provide the tool.
Advisor consultation requires v0.3.0 or later; v0.2.0 does not provide the tool.

## Parallel fan-out

- Single calls and parallel batches are supported. A batch accepts up to 32 tasks.
- By default, six child agents run at once across all calls in one parent runtime.
- Extra tasks wait in a shared FIFO queue. Batch size and active concurrency are
  separate limits.
- Every task has its own result, lifecycle state and optional working directory.
  Results retain input order, including repeated roles and failed tasks.
- Parallel calls return when the entire batch finishes. Progress updates are not
  background-job results; there is no start/status/wait job API.
- Only user-level agent definitions are enabled.
  Chain mode and project-local agents remain disabled.
- Every definition must declare a non-empty tool allowlist.

For example, a batch of 32 tasks at default capacity runs at most six children
at a time. Several overlapping batches still share those six slots.

## Configure concurrency

Set the limits before starting Pi:

```sh
PI_SUBAGENT_MAX_CONCURRENCY=8 PI_SUBAGENT_CONCURRENCY_CEILING=12 pi
```

`PI_SUBAGENT_MAX_CONCURRENCY` is the base limit (1 through 16, default 6).
`PI_SUBAGENT_CONCURRENCY_CEILING` (1 through 16) is the most a single call can
raise it to. It defaults to 8, or to the base limit if that is higher. A ceiling
below the base limit, or any invalid value, disables spawning and reports an
error. Both are read once when the extension loads.

In parallel mode the agent can pass `maxConcurrency` to raise the active limit for
that call, clamped to the ceiling (the result says so). It only raises: a lower value changes nothing,
and the raise ends when the call ends. Running children are never stopped when a
raise ends; queued tasks wait until active children drop below the base limit.
Overlapping calls use the highest raise that is still active.

Six is the default for mixed work. Eight or more can help
independent exploration and review, but increases simultaneous model requests,
CPU and memory use. The tests verify scheduling at 6, 8 and 16 using fake children;
real provider rate limits and throughput have not been benchmarked.

The limit is per parent runtime, not machine-wide. Other Pi sessions have their
own limits. It does not limit test-runner workers or unrelated model requests.
The aggregate queue across overlapping calls has no admission limit.

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

Parallel model-facing text has a 128 KiB total budget, including headers and
notices. Short results leave more room for longer ones, up to the per-task limit.
These limits are not a bound on the entire Pi process's memory use.

History eviction and oversized-message previews are recorded in the result's
`output` metadata. Usage totals still count all parsed messages. UTF-8 characters
are preserved across pipe chunks and truncation boundaries. A stdout line over
the limit fails the task and triggers child termination.

Discarded content is not saved elsewhere. Expanded tool details contain only the
retained history and previews, not necessarily the full transcript. Complete
final answers remain complete even when earlier tool output was evicted.

Throwing progress observers cannot crash the parent or reject a batch. Stream
processing errors terminate the affected child and report task failure.

## Safe parallel work

The parent assigns independent writable files, settles shared contracts, and
inspects the combined changes. Separate contexts do not isolate the filesystem,
credentials, ports, databases or build outputs. Worktrees do not isolate ports or
external services. Tool allowlists are not an operating-system sandbox.

Agent prompts and model assignments live in your own `~/.pi/agent/agents/*.md`
files. This extension has no model table of its own.

## Cancellation and shutdown

Cancelled queued tasks never spawn. Active children receive SIGTERM, followed by
SIGKILL after five seconds if still alive. Slots stay occupied until the child
closes and cleanup finishes. Shared abort signals use one listener per runtime.

Pi awaits the idempotent shutdown handler on reload, session replacement and quit.
It aborts queued work and waits for active children to terminate. Prompt temporary
files, listeners and escalation timers are cleaned up.

There is no automatic task timeout. A hung child can occupy a slot until cancelled.
Killing the direct child does not guarantee descendant cleanup. Descendants holding
output pipes open can prevent `close` and shutdown from finishing indefinitely.
Briefs that start services must include their own cleanup instructions.

## Verification

From the source directory:

```sh
node --test --test-timeout=30000 *.test.mjs
```

The tests cover the scheduler, cancellation, output bounds, rendering, installer,
and actual Pi extension loading with fake child processes. They make no paid
model calls. The 1,000-submission scheduler test uses simulated processes.

Loader tests resolve the current managed Pi installation. For another installation,
set `PI_CORE_DIR` to its `@earendil-works/pi-coding-agent` package directory.
SIGKILL escalation uses process/timer fakes; descendant cleanup is not guaranteed
or tested.

## Status and known limitations

This is an early release (0.3). Please read these before relying on it:

- **Package install checked once.** One real Pi session loaded `v0.2.0` through
  `pi -e git:github.com/codecapitano/pi-subagent@v0.2.0`. The model read the agent
  list from the tool description, made a parallel call with two tasks, and the result
  carried the clamp notice. This was a single short run, not a long-term test.
- **Agents are not bundled automatically.** Copy the starter agents yourself (see
  [Define agents](#define-agents)). The agent list in the tool description is read at
  load, so run `/reload` after changing agents.
- **No background jobs.** The parent waits for the whole batch, and there is no
  automatic task timeout. A hung child holds a slot until cancelled.
- **Tests need a Pi installation.** The loader tests read Pi from
  `~/.pi/agent/install`, or from `PI_CORE_DIR`. CI installs Pi 1.3.0 from npm.
- **Legacy code.** Chain mode and project-local agents are rejected but still
  present in the source, for compatibility with stored calls.
- **Unverified in practice.** The tests use fake child processes. Real provider rate
  limits, throughput and how models use `maxConcurrency` have not been measured.

## Credits and license

Derived from the subagent example in the
[Pi repository](https://github.com/earendil-works/pi), which is MIT licensed.
This project is released under the [MIT License](LICENSE).
