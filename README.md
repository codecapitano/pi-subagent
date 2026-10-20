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

Requires Node.js and an existing Pi installation. From this directory, while no
subagents are running:

```sh
node scripts/install.mjs
```

The installer copies the runtime, documentation and offline tests to
`~/.pi/agent/extensions/subagent/` as regular files. It backs up existing owned
files under `~/.pi/agent/backups/`, preserves unrelated files, and refuses symlink
destinations. Agent definitions in `~/.pi/agent/agents/` are not modified.
File replacements are individually atomic, not a transaction across all files. If
installation fails partway through, restore the reported backup or rerun the
installer before reloading Pi.

Run `/reload` while Pi is idle, or restart Pi. The loaded extension does not
change when files on disk change.

To install into another directory:

```sh
node scripts/install.mjs /path/to/extensions/subagent
```

Set `PI_SUBAGENT_BACKUP_DIR` to override the backup directory. Empty overrides
and known extension discovery roots are rejected. Keep backups outside any other
extension directory. Interrupted installations can leave hidden staging folders
inside the destination; they are not auto-discovered and can be removed while Pi
is idle.

Do not also load this repository as an extension, or it can register twice.

## Prompt guidance

The tool registers its own `promptSnippet` and `promptGuidelines`, which Pi adds to
the system prompt while the tool is active. Pi's model learns when to delegate, how
to write a brief and to verify results without any `AGENTS.md` entry. To change the
policy for your own setup, for example which agent to use for which job, add that to
your `AGENTS.md`.

## Define agents

Create Markdown agent definitions in `~/.pi/agent/agents/`. Every definition must
declare a non-empty tool allowlist. Only user-level definitions are enabled;
chain mode and project-local agents are disabled.

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
that call, clamped to the ceiling. It only raises: a lower value changes nothing,
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

## Credits and license

Derived from the subagent example in the
[Pi repository](https://github.com/earendil-works/pi), which is MIT licensed.
This project is released under the [MIT License](LICENSE).
