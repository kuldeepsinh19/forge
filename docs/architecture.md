# Architecture

How a task moves through Forge, what each stage may see, and where the line between
deterministic code and model reasoning falls.

## The shape of it

```
src/
  core/        types (the state shape), config, pipeline (the sequencer)
  provider/    the model seam; the Anthropic implementation
  telemetry/   per-request recording, priced cost accounting
  retrieval/   workspace probe, search, citation checking
  stages/      investigate · implement · review, their prompts and tools
  validate/    running the repository's own commands
  git/         branch, diff, commit, push
  github/      pull request delivery and issue intake
  cli/         the command line interface
```

Each module answers one question. `retrieval` answers "what is in this repository",
`telemetry` answers "what did this cost", `validate` answers "did it pass". Nothing
reaches across those boundaries except through the types in `core/types.ts`.

## Deterministic versus model

This split is the load-bearing design decision.

| Deterministic code | Model reasoning |
|---|---|
| Sequencing the stages | Understanding the problem |
| Probing the workspace | Finding the root cause |
| Searching, reading, listing | Writing the plan |
| Checking citations | Writing the code |
| Running tests, lint, typecheck | Judging the diff |
| Producing the diff | |
| Branching, committing, pushing | |
| Deciding pass or fail | |
| Writing the pull request body | |
| Computing cost | |
| Compacting history | |

A model is used where judgement is required and nowhere else. The clearest case is
validation: "did the test suite pass" has a correct answer available for the price of a
subprocess, so the exit code decides and the model is told the answer rather than asked
for it.

The second clearest case is orchestration. The stage order is known before the run starts,
so `run()` in `src/core/pipeline.ts` is an ordinary function with an ordinary loop. An
orchestrating agent would mean carrying a large context through every step of a fixed
sequence, which is cost with no corresponding judgement.

## Stage contracts

Each stage declares what it receives and what it returns. A stage receives a **projection**
of `TaskState`, never the object entire, and never another stage's conversation.

### Investigate

| | |
|---|---|
| **Receives** | The task verbatim; the frozen workspace profile |
| **Tools** | `search_code`, `read_file`, `list_files`, `search_history`, `recent_changes` — all read-only |
| **Returns** | `problemStatement`, `rootCause`, `evidence[]`, `affectedFiles[]`, `plan[]`, `acceptanceCriteria[]`, `assumptions[]`, `testStrategy` |
| **Post-check** | Every citation is verified against the tree. Claims that fail are discarded. If none survive, the stage fails. |

The acceptance criteria written here become the contract the review stage judges against,
verbatim. Separating "who defines correct" from "who judges correct" is what stops a
reviewer inventing its own, easier bar.

### Implement

| | |
|---|---|
| **Receives** | The task; the problem statement and root cause; **the exact cited spans**; the plan; the criteria; the assumptions; the test strategy |
| **Tools** | The read-only set, plus `write_file` |
| **Returns** | `changes[{path, rationale}]`, `deviations[]`, `knownLimitations[]` |

Including the cited spans is a deliberate cost trade: they are the exact code the plan was
written against, so sending them removes a round of re-reading that would otherwise be
paid for anyway.

`write_file` replaces a whole file rather than applying a patch. Whole-file writes cannot
fail the way fuzzy patch application does, and the diff is then produced by git rather
than described by the model — so the change summary and the actual change cannot drift
apart.

On a revision cycle the stage receives the reviewer's findings and the failed criteria,
but **not** the cited spans again. It has already read those files this run; the findings
are what is new.

### Review

| | |
|---|---|
| **Receives** | The task; the acceptance criteria; the real diff from git; the validation results |
| **Does not receive** | The implementation stage's reasoning, rationale, transcript, or self-assessment |
| **Tools** | Read-only, so it can check claims against the tree |
| **Returns** | `verdict`, `criteriaResults[{criterion, pass, evidence}]`, `blockingFindings[]`, `suggestions[]`, `summary` |

Independence is structural. The review stage is not asked to be objective; it is simply
never given the material that would compromise it.

Two contradictions are caught in code rather than trusted to the model:

- Approving while reporting blocking findings is downgraded to `request_changes`.
- Approving while validation failed is treated as `request_changes`.

### Deliver

| | |
|---|---|
| **Runs when** | The review approved *and* `github.createPullRequest` is on |
| **Does** | Pushes the branch, opens a pull request via the REST API |
| **Body** | Assembled from `TaskState`, not written by a model |

Every failure here is a warning rather than an exception. The work is already committed
locally, so a missing token or a non-GitHub remote should downgrade the outcome, not
discard it.

## Bounding the conversation

The agent loop compacts before sending, not after — trimming afterwards would already have
paid for the oversized turn.

When the estimated conversation exceeds `limits.historyBudgetTokens`, the *content* of the
oldest tool results is replaced with a short placeholder. The blocks themselves stay,
because Anthropic requires every `tool_use` to be answered by a matching `tool_result`, so
removing them outright would make the request invalid. The task message and the most
recent turns are never touched.

Compaction breaks the cached prefix from that point on, so it is deliberately chunky: it
frees down to roughly half the budget rather than trimming to fit exactly, to avoid paying
that penalty every turn afterwards.

## The spend cap

`limits.maxCostUsd` is checked before every model call against telemetry that has already
been written, so it is a real ceiling rather than an estimate. The call in flight when the
cap is reached still completes, so actual spend can exceed it by one call. Zero disables it.

## State

`TaskState` in `src/core/types.ts` is the single carrier. Every field beyond `task`,
`repository` and `status` is absent until the stage that produces it has run.

```
task            the request, verbatim
repository      root, base branch, base commit, frozen profile
status          pending → investigating → implementing → validating → reviewing → …
investigation   root cause, evidence, plan, acceptance criteria
implementation  per-file changes, deviations, known limitations
validations     one result per command, with exit codes
review          verdict and per-criterion results
branch          once created
revisionCount   bounded by config
warnings        non-fatal problems worth surfacing
```

Stages read narrow slices. Nothing appends to a growing transcript.

## The workspace profile

Probed once at the start of a run, then frozen for its duration. It records languages,
package manager, source and test directories, project marker files, discovered validation
commands, and any repository-authored instructions.

It is frozen for a specific reason: it is rendered into the **cached prefix** of every
prompt. If it changed between turns the prefix would change with it, and prompt caching
would stop hitting — which costs far more than the staleness saves. Nothing in the profile
is expensive to be slightly wrong about; it is orientation, not evidence.

The probe is bounded on every axis: the file sweep stops at a fixed count, directory
recursion has a depth limit, and the git probe has a timeout. A probe that can hang on a
large monorepo is not a cheap probe.

## The agent loop

One loop, in `src/stages/agent-loop.ts`, shared by all three stages. A stage ends when the
model calls its submit tool with output matching a Zod schema.

- The system prompt is passed unchanged every turn. Anything that varies goes in messages.
- A submission that fails validation is returned once with the specific errors, because a
  schema violation is usually a near miss rather than a misunderstanding. A second failure
  ends the stage.
- A tool that throws returns its error to the model rather than killing the run.
- Turns are capped.

## Validation

Ordered cheapest first — typecheck, lint, test, build — because a typecheck failure makes
the test run irrelevant, and finding out in four seconds beats finding out in four minutes.

Commands come from the repository. Output is captured from the **tail**, since test
runners put failures and summaries at the end.

## Telemetry

One row per model call, written before the response is consumed, so a crashed run still
leaves a usable cost record.

The distinction that matters most: `inputTokens` is the **uncached remainder only**. Total
prompt volume is `inputTokens + cacheCreationInputTokens + cacheReadInputTokens`. Reporting
`input + output` as "total tokens" understates real context volume by an order of magnitude
in a well-cached agent and, perversely, makes a badly-cached system look leaner.

So Forge reports `contextVolume`, `cacheHitRatio` and `prefixStable` per stage.

Two cache breakpoints are set per request: one on the system prompt, and one on the last
block of the conversation. The second matters more. System and tools together come to
roughly 900 tokens, below Anthropic's 1024-token minimum, so that breakpoint alone would
never create a cache entry — and the growing tool-result history, which is where tokens
actually accumulate within a stage, would be re-billed in full every turn. A breakpoint at
the end of the conversation caches everything before it cumulatively.
`prefixStable` is false when a stage rendered more than one distinct system prompt across
its turns — a bug that is otherwise invisible until it shows up on a bill.

## Extending

**A tool**: add it to `src/stages/tools.ts` and include it in the relevant stage's list.
Bound its output. Schemas are re-sent every turn, so an unused tool is a tax on every
request of that stage.

**A provider**: implement `ModelProvider`. It is transport only — translate the request,
call the vendor, report what it used. Recording and pricing are applied by
`RecordingProvider`, which the pipeline wraps around whatever the factory returns, so a
new provider cannot produce an unaccounted run. `TelemetryContext` is still a required
argument on the interface: a stage that cannot name itself cannot call the model.

**A stage**: add its contract to `TaskState`, write a schema and prompt, call
`runAgentLoop`, and wire it into `run()`. Before doing so, check whether the work needs
judgement at all — if deterministic code can do it, it should.
