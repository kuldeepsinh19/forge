# Evaluation

Forge publishes no performance numbers yet. This document describes the methodology that
will produce them, written before the measurements exist so the results cannot be shaped
after the fact.

## What Forge measures on every run

These are not benchmark results. They are instrumentation, emitted for any run, written to
`.forge/runs/<timestamp>/`.

| File | Contents |
|---|---|
| `requests.jsonl` | One row per model call, written before its response is consumed |
| `summary.json` | Per-stage aggregates and the run total |
| `state.json` | The final `TaskState`: investigation, implementation, validation, review |

Each request row records the resolved model id, the stage, the turn index, token usage
with cache reads and writes counted separately, the stop reason, latency, a hash of the
system prompt, the tool count, the price-table version and the computed cost. It records
no prompt or response text.

## The measurements that matter

### Context volume, not "total tokens"

```
contextVolume = inputTokens + cacheCreationInputTokens + cacheReadInputTokens
```

`inputTokens` is the **uncached remainder only**. An agent that ran for an hour and reports
4,000 input tokens served the rest from cache. Reporting `input + output` as "total tokens"
understates real prompt volume by an order of magnitude in a well-cached agent and, less
obviously, makes a *badly* cached system look leaner than a well-cached one.

### Cache hit ratio

```
cacheHitRatio = cacheReadInputTokens / contextVolume
```

Reported per stage. This is the number that decides whether "context is curated, not
accumulated" is a description or a slogan. A pipeline that re-composes prose for each
stage cannot score well here regardless of how small its individual prompts look.

### Prefix stability

`prefixStable` is false for any stage that rendered more than one distinct system prompt
across its turns. Caching only helps when the prefix is byte-identical, and prefix drift is
otherwise invisible until it shows up on a bill.

### Citation accuracy

The fraction of investigation claims whose citations resolved against the working tree.
This measures how often the model asserts things about code that is not there — and,
because unverifiable claims are discarded rather than passed on, how much work the
grounding mechanism is actually doing.

### Cost

Computed from a dated price table checked into the repository, never fetched at runtime.
Fetching at runtime would silently re-price every historical run when a vendor changes a
number. Because usage fields are stored raw, cost can be recomputed offline, so a pricing
mistake is a script re-run rather than an evaluation re-run.

## Planned methodology

### Suite

**SWE-bench Verified** as the primary suite: 500 human-validated instances, the common
frame of reference, and gradeable in the cloud so no large local Docker installation is
required. **SWE-bench Multilingual's** JavaScript and TypeScript subset afterwards, to test
whether retrieval is genuinely language-agnostic.

Instances will be a frozen list checked into the repository, stratified by the suite's own
difficulty field, with per-stratum results published alongside the aggregate. An aggregate
that hides an easy-instance skew is not a result.

Note that Forge being written in TypeScript does not restrict it to TypeScript
repositories: it shells out to whatever the target repository declares. The constraint a
Python benchmark imposes is on the retrieval layer, which must stay on language-agnostic
foundations — ripgrep, git, and tree-sitter — rather than TypeScript-specific tooling.

### Delivery targets

The same instances will run through two paths: one emitting a patch, which the standard
harness can grade, and one opening a real pull request into a mirrored repository. The
difference between them isolates the cost and reliability of the review and delivery
stages, without needing a separate benchmark for them.

### Defining success

Two predicates, computed independently:

- **resolved** — with the change applied and the suite's own tests restored, the
  fail-to-pass tests pass and the pass-to-pass tests still pass.
- **shipped** — the branch exists, the repository's own checks are green, the review stage
  approved with no blocking findings, and every evidence citation resolves.

The headline figure is total spend across every attempt, including failures and revisions,
divided by the instances that are both resolved and shipped.

The four-way disagreement between those predicates is a result in itself, not noise. A
change the reviewer approved that the hidden tests reject is the case a maintainer actually
pays for, and it will be reported as a raw count rather than folded into a rate.

The review stage will never see the hidden tests. If it can, the measurement is void.

### Reporting

- Runs are nondeterministic. Published accuracy comparisons will state the number of runs
  and a confidence interval, and small differences will not be claimed as improvements.
- Per-instance cost is heavy-tailed, so median and p90 will be reported alongside the mean.
- Step and turn limits will be published for every configuration, because cost is a
  function of them and comparisons across different limits are not meaningful.
- The exact model ids, the dataset revision, the frozen instance list, and any exclusions
  with their reasons will be published with the results. Exclusions will be decided before
  the run, not after.

## What would falsify the design

A project that cannot be wrong is not making a claim. Three results would count against
Forge's thesis:

1. **Low cache hit ratios despite stable prefixes** — the handoff design is not doing what
   it claims.
2. **High citation accuracy without the checking mechanism** — the mechanism is decorative
   and the grounding claim is unearned.
3. **Cost dominated by irreducible work** — reading the code that must be read and
   generating the diff that must be generated. If that is where the tokens are, then
   context engineering is not the lever, and model routing and caching carry the load
   instead.

The instrumentation is built to surface all three rather than hide them.
