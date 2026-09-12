# Forge

**Context-efficient AI agents for software engineering.**

Forge turns a software task into an investigated, implemented, validated and
independently reviewed change. Focused context, evidence-backed reasoning, deterministic
execution.

[![CI](https://github.com/kuldeepsinh19/forge/actions/workflows/ci.yml/badge.svg)](https://github.com/kuldeepsinh19/forge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)

> **Status: early. v0.1.** The pipeline runs end to end and the deterministic core is
> tested, but it has not been evaluated at scale. There are no benchmark numbers in this
> README because there is no benchmark data yet — see [Evaluation](#evaluation).

---

## Why Forge

Most agent frameworks make the same trade. Give an agent less context and it hallucinates
files that do not exist. Give every stage more context and cost grows with the square of
the pipeline, because each stage re-receives what the last one already read.

Forge takes a third position: **context is curated, not accumulated.**

```
Naive multi-stage                    Forge

  Agent A                              Repository
     │ everything                          │  deterministic retrieval
     ▼                                     ▼
  Agent B                              Evidence  ── citations verified
     │ everything + A                       │
     ▼                                     ▼
  Agent C                              Focused context
     │ everything + A + B                   │
     ▼                                     ▼
  Agent D                              Reasoning
                                           │
                                           ▼
                                     Typed handoff  ── not a transcript
                                           │
                                           ▼
                                        Next stage
```

Each stage receives a **projection** of typed state containing only the fields it needs.
No stage sees another stage's conversation.

## Core principles

**Context efficiency.** Relevance beats volume. Stages exchange typed state, never
transcripts, and the system prompt is held byte-stable across a stage's turns so prompt
caching actually hits. Forge reports its own cache hit ratio per stage, so the claim is
checkable rather than asserted.

**Evidence-driven reasoning.** Every conclusion the investigation stage reaches must cite
a file and a line range. Those citations are then **checked mechanically against the
working tree**. A claim citing a file that does not exist, a range past the end of a file,
or a blank span is discarded before it can reach the next stage.

**Deterministic tooling.** Sequencing, searching, diffing, branching, committing,
validating and citation-checking are ordinary code. No model decides whether the tests
passed — the exit code does.

**Minimal specialization.** Three reasoning stages, not six. A stage exists only where
judgement is genuinely required.

**Independent verification.** The review stage sees the task, the acceptance criteria, the
real diff and the validation results. It does **not** see the implementation stage's
reasoning. Independence is a property of what the context contains, not a request in a
prompt.

**Measurable execution.** Every model call is recorded before its response is consumed:
tokens, cache reads and writes separately, resolved model, stage, latency and priced cost.

## How it works

```
                    ┌──────────────────┐
                    │   Task (CLI,     │
                    │   file, issue)   │
                    └────────┬─────────┘
                             ▼
                    ┌──────────────────┐   deterministic: languages, package
                    │ Workspace probe  │   manager, test/lint/build commands.
                    └────────┬─────────┘   Probed once, then frozen.
                             ▼
                    ┌──────────────────┐   search_code · read_file · list_files
                    │  Investigate     │   search_history · recent_changes
                    └────────┬─────────┘
                             ▼
                       ┌───────────┐
                       │ Citations │  ◀── verified against the working tree;
                       │  checked  │      unverifiable claims are discarded
                       └─────┬─────┘
                             ▼
                    ┌──────────────────┐   receives the plan, the criteria, and the
                    │   Implement      │   exact cited spans. Not the transcript.
                    └────────┬─────────┘
                             ▼
                    ┌──────────────────┐   the repository's own commands.
                    │    Validate      │   No model involved.
                    └────────┬─────────┘
                             ▼
                    ┌──────────────────┐   fresh context. Sees the real diff and
                    │     Review       │   the validation results, not the
                    └────────┬─────────┘   implementer's reasoning.
                             ▼
                   approve ──┴── request_changes ──▶ revise (bounded)
                       │
                       ▼
                    commit
                       │
                       ▼
              ┌──────────────────┐   push the branch, open a pull request
              │     Deliver      │   whose body is built from run state.
              └────────┬─────────┘   Opt-in, and only on approval.
                       ▼
                 GitHub pull request
```

The stage sequence is a `for` loop in [`src/core/pipeline.ts`](src/core/pipeline.ts), not
an orchestrating agent. The order is knowable in advance, so nothing is gained by paying a
model to decide it.

## Quick start

Forge is not on npm yet, so install it from source:

```bash
git clone https://github.com/kuldeepsinh19/forge.git
cd forge && npm install && npm run build && npm link
export ANTHROPIC_API_KEY=sk-...
```

Or run it without installing:

```bash
npx github:kuldeepsinh19/forge inspect
```

See what Forge detects about your repository. This calls no model and costs nothing:

```bash
forge inspect
```

```
Repository: /home/you/project

  Languages       TypeScript
  Package manager pnpm
  Source dirs     src
  Test dirs       tests
  Project files   package.json, AGENTS.md

  Validation commands discovered from this repository:
    test       pnpm run test
    lint       pnpm run lint
    typecheck  pnpm run typecheck
```

Investigate a task without changing anything:

```bash
forge run --dry-run "Users can submit the checkout form twice on a slow network"
```

Run the full pipeline:

```bash
forge run "Users can submit the checkout form twice on a slow network"
```

Forge requires a clean working tree, creates its own branch, and never commits to `main`,
`master`, `develop` or `trunk`.

## Example

```
▸ Investigating
    · search_code
    · read_file
  Investigation complete: 1 grounded claim(s), 2 acceptance criteria

▸ Implementing
    · read_file
    · write_file
  Implementation touched 1 file(s)

▸ Validating
  test: npm run test
  test passed

▸ Reviewing
  Review: approve (2/2 criteria passed)
  Committed 3df0339d0450

▸ Delivering
  Pushed forge/add-subtracts-instead-of-adding-da8ae4d0 to origin
  Opened draft pull request #2

──────────────────────────────────────────────────────────────

  Status      approved
  Branch      forge/add-subtracts-instead-of-adding-da8ae4d0
  Root cause  The operator in add() is '-' where it should be '+'.
  Evidence    1 grounded claim(s), 100% of citations resolved
  Changed     src/calc.js
  Validation  test: pass
  Review      approve — 2/2 criteria
  Pull req    #2 https://github.com/owner/repo/pull/2

  stage         reqs   ctx vol    cached    cost     prefix
  ─────────────────────────────────────────────────────────
  investigate      -          -        -          -   stable
  implement        -          -        -          -   stable
  review           -          -        -          -   stable
```

> The pipeline output above is from a real run. The telemetry columns are left blank
> deliberately: no token or cost figures are published until they are measured. See
> [Evaluation](#evaluation).

## Delivering a pull request

By default Forge stops at a local commit on its own branch. Add `--pr` (or set
`github.createPullRequest`) to push the branch and open a pull request once review
approves:

```bash
forge run --pr "Users can submit the checkout form twice on a slow network"
forge run --issue 42 --pr          # take the task from a GitHub issue, and close it
```

The pull request body is assembled from the run's own state — problem statement, root
cause with verified citations, per-file changes, the validation table, the reviewer's
per-criterion verdict, and any residual risks. None of it is generated prose, so the
description cannot claim something the pipeline did not do.

A pull request is opened **only on approval**. A rejected or failed run leaves the branch
local. Authentication uses `GITHUB_TOKEN`, falling back to `gh auth token`. If there is
no token, or the remote is not GitHub, the run warns and keeps the commit rather than
failing.

## Configuration

`forge init` writes a starter `forge.config.json`. Everything is optional; defaults apply
when a key is absent.

```json
{
  "models": {
    "investigate": "claude-sonnet-5",
    "implement": "claude-opus-5",
    "review": "claude-sonnet-5"
  },
  "limits": {
    "maxTurnsPerStage": 30,
    "maxRevisions": 2,
    "validationTimeoutMs": 600000,
    "historyBudgetTokens": 60000,
    "maxCostUsd": 0
  },
  "git": {
    "branchPrefix": "forge",
    "autoCommit": true
  },
  "github": {
    "createPullRequest": false,
    "draft": true,
    "remote": "origin"
  },
  "validation": {
    "test": null,
    "lint": null,
    "typecheck": null,
    "build": null
  }
}
```

`validation` entries override command discovery. `null` means "use whatever the repository
declares" — Forge reads `package.json` scripts, and recognizes Cargo, Go and Python
projects. A command it cannot discover is skipped rather than guessed, because a command
Forge invented fails for reasons that teach nobody anything.

Review defaults to a different model from implementation on purpose: a reviewer sharing
the implementer's model shares its blind spots.

## Providers

Anthropic is implemented today. Adding a vendor means implementing one interface:

```ts
interface ModelProvider {
  readonly vendor: string;
  readonly model: string;
  complete(request: CompletionRequest, telemetry: TelemetryContext): Promise<CompletionResult>;
}
```

A provider is transport only. Recording and pricing are applied by a wrapper the pipeline
puts around every provider, so a new vendor cannot produce an unaccounted run.
`TelemetryContext` is a required argument on the interface: a stage that cannot name
itself cannot call the model, which is what makes per-stage cost attribution exact rather
than reconstructed from logs afterwards.

## Security

Forge executes code from the repository it is working in. Read
[SECURITY.md](SECURITY.md) before pointing it at a repository you do not control.

In short: repository content is untrusted. `AGENTS.md` and `CLAUDE.md` are fenced and
labelled as untrusted in the prompt rather than treated as instructions. Model-supplied
paths are rejected if they escape the repository root. Branch names are validated against
an allowlist and protected branches are refused in code. Validation commands come from the
repository's own configuration, never from a model. Forge does not sandbox the code it
runs — that is your responsibility, and it is the most important open limitation.

## Evaluation

There are no benchmark numbers here yet, and none will be published until the methodology
below is actually executed. The methodology is written up first, deliberately, so the
results cannot be shaped after the fact:
[`docs/evaluation.md`](docs/evaluation.md).

What Forge already measures on every run, written to `.forge/runs/<timestamp>/`:

| Field | Why it matters |
|---|---|
| `contextVolume` | `input + cacheCreation + cacheRead`. `inputTokens` alone is only the uncached remainder and understates real prompt volume badly. |
| `cacheHitRatio` | Per stage. The number that decides whether "context is curated" is true or marketing. |
| `prefixStable` | Whether a stage rendered a byte-identical system prompt on every turn. Drift here silently destroys caching. |
| `costUsd` | Computed from a dated price table checked into the repo, recomputable offline. |
| Citation accuracy | Fraction of investigation claims whose citations resolved against the tree. |

## Architecture

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Stage contracts, state shape, what is deterministic |
| [docs/context-engineering.md](docs/context-engineering.md) | Retrieval, evidence, handoffs, cache stability |
| [docs/evaluation.md](docs/evaluation.md) | What is measured, and the methodology for what is not yet |
| [SECURITY.md](SECURITY.md) | Threat model and trust boundaries |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local setup, adding a tool, a stage or a provider |

## Roadmap

**Working today** — the three-stage pipeline, deterministic retrieval and validation,
citation checking, bounded revision cycles, history compaction, an enforced spend cap,
per-request telemetry with prompt caching, GitHub issue intake, pull request delivery, the
Anthropic provider, and the `run` / `init` / `inspect` commands.

**Near term** — an evaluation harness against a public benchmark, published cost figures,
a second provider to make the seam honest, and npm distribution.

**Possible later** — richer retrieval such as symbol-level indexing, additional code hosts,
task sources such as Linear or Jira, and configurable human approval gates.

Nothing above is a commitment, and nothing in "working today" is aspirational.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and
where things live. The short version:

```bash
git clone https://github.com/kuldeepsinh19/forge.git
cd forge
npm install
npm test
```

## License

MIT — see [LICENSE](LICENSE).
