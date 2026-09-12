# Contributing

Thanks for looking. Forge is early, so the most useful contributions right now are bug
reports from real repositories and improvements to retrieval and evaluation.

## Setup

```bash
git clone https://github.com/kuldeepsinh19/forge.git
cd forge
npm install
npm test
```

Node 20 or later. No other prerequisites: ripgrep is used when present and a portable
JavaScript scan is used when it is not.

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint, zero warnings tolerated
npm run format        # prettier --write
npm test              # vitest
npm run build         # tsc -> dist/
npm run dev -- inspect  # run the CLI from source
```

## Where things live

| Path | Responsibility |
|---|---|
| `src/core/` | `types.ts` is the state shape; `pipeline.ts` sequences stages; `config.ts` loads settings |
| `src/provider/` | The model seam and the Anthropic implementation |
| `src/telemetry/` | Per-request recording and priced cost accounting |
| `src/retrieval/` | Workspace probe, search, citation checking |
| `src/stages/` | The three reasoning stages, their prompts, tools, and the shared agent loop |
| `src/validate/` | Running the repository's own commands |
| `src/git/` | Branch, diff, commit |
| `docs/` | Architecture and context engineering |

Read [docs/architecture.md](docs/architecture.md) before changing anything in `core/` or
`stages/`.

## The rule that shapes most decisions

> Do not use a model for work that deterministic code can do.

Before adding a stage, a tool, or a prompt instruction, ask whether ordinary code could
produce the same answer. If it could, it should. Validation is the canonical example: "did
the tests pass" is decided by an exit code, and the model is told the answer rather than
asked for it.

## Adding a tool

Add it to `src/stages/tools.ts` and include it in the relevant stage's tool list.

- **Bound the output.** Every existing tool caps its result. An unbounded tool result is
  the usual way context and cost explode without anyone noticing.
- **Scope it to the stages that need it.** Schemas are re-sent on every turn, so a tool
  the investigation stage never calls is a tax on every investigation request.
- **Validate model-supplied paths** with `resolveInsideRoot`. Never trust a path.
- **Return errors as strings**, not exceptions. The loop turns a throw into a message, but
  a clear message helps the model recover.

## Adding a provider

Implement `ModelProvider` from `src/provider/types.ts`. A provider is **transport only**:
translate the request, call the vendor, and report the usage the vendor reported. You do
not record telemetry or compute cost — `RecordingProvider` wraps your provider and does
both, so the accounting guarantee holds structurally rather than by convention.

Two things are not optional:

1. Report cache-read and cache-write tokens **separately** from base input. They are priced
   differently and the difference dominates any honest cost figure.
2. Return the resolved model id from the response, not the one that was requested. They
   differ when an alias is used, and pricing follows the resolved one.

Add the model's prices to the table in `src/telemetry/cost.ts` with its own
`cacheReadMultiplier`; it varies by model and must not be hardcoded at the call site.

## Adding a stage

First, be sure it needs a model. If it does:

1. Add its output contract to `TaskState` in `src/core/types.ts`.
2. Write a Zod schema and a matching JSON Schema for the submit tool.
3. Write a prompt in `src/stages/prompts.ts`. It must be **pure and stable**: no
   timestamps, no counters, no unordered iteration. The prompt is the cached prefix.
4. Call `runAgentLoop`.
5. Wire it into `run()` in `src/core/pipeline.ts`.
6. Decide deliberately what the stage may and may not see. That decision is the design.

## Tests

`npm test`. The deterministic core is tested without any API calls, and it should stay
that way — `tests/agent-loop.test.ts` shows the scripted-provider pattern for testing
model-driven control flow for free.

Test the failure paths. A citation checker is only interesting for what it wrongly
*accepts*, so the evidence tests concentrate there.

Please do not add tests to raise a count. A test that cannot fail is worse than no test.

## Pull requests

- One concern per pull request.
- `npm run typecheck && npm run lint && npm test && npm run build` should pass before you
  open it. CI runs the same on Linux, macOS and Windows against Node 20 and 22.
- Explain **why**, not just what. The diff already says what.
- If you change behaviour, update the affected doc in the same PR.
- New dependencies need a justification. The runtime dependency list is two packages and
  should stay small.

## Reporting bugs

Include the Forge version, your OS and Node version, what you ran, what happened, and what
you expected. If a run produced a directory under `.forge/runs/`, `summary.json` is useful
and contains no prompt or response text.

Security issues go through [SECURITY.md](SECURITY.md), not the public tracker.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
