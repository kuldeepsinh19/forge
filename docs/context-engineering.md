# Context engineering

The techniques behind "context is curated, not accumulated", and how each one is
measurable rather than asserted.

## The problem

A multi-stage agent pipeline has an obvious failure mode in each direction.

Starve a stage of context and it hallucinates: it names files that do not exist, assumes
APIs that were never written, and produces plans that cannot be executed. Feed every stage
everything and cost grows super-linearly, because stage *n* pays to re-read what stages
*1..n-1* already read, and none of it is cacheable if it arrives freshly re-worded each
time.

Neither is fixed by choosing a point on that dial. Both are fixed by changing what travels
between stages.

## Five techniques

### 1. Deterministic retrieval before reasoning

Before any model call, Forge probes the repository with ordinary tools: a bounded file
sweep for the language census, lockfile detection for the package manager, `package.json`
and friends for validation commands, and a short `git` probe. This costs no tokens.

The result is the **workspace profile**, and it answers the orientation questions a model
would otherwise burn three or four turns discovering.

Inside a stage, the same principle applies to the tool surface: `search_code` across the
whole repository is far cheaper than reading one wrong file, so the prompts push search
before reads explicitly.

### 2. Progressive disclosure

Nothing is loaded that has not been asked for. There is no repository dump, no file tree
in the prompt, no preloaded "relevant files".

Every tool result is bounded, because an unbounded result is the usual way context
explodes without anyone noticing:

| Tool | Bound |
|---|---|
| `search_code` | 60 matches, 10 per file, 300 chars per line |
| `read_file` | 400 lines per call, 500 chars per line |
| `list_files` | 300 shown, remainder counted |
| Diff into review | 60,000 chars, then truncated |
| Validation output | 4,000 chars, kept from the **tail** |

Truncating validation output from the front would discard exactly the part that matters,
since runners put failures and summaries at the end.

### 3. Evidence with verified citations

The investigation stage cannot simply assert. Each claim carries one or more citations of
the form `path` + `startLine` + `endLine`, and after the stage returns, each is checked
against the working tree:

- the path must resolve inside the repository root (traversal is rejected)
- the file must exist and be readable
- the range must be within the file, correctly ordered, and 1-indexed
- the span must not be blank
- the span must be under 400 lines, because a 900-line citation cites nothing in particular

A claim with **any** failing citation is discarded whole. A claim standing on one real
citation and one fabricated one is not two-thirds true, and the fabricated half is the part
that matters.

This changes the economics inside the model's own loop: guessing costs more than looking,
because a guess that fails the check produces nothing at all.

The surviving fraction is reported as citation accuracy, so the mechanism's effectiveness
is itself a number rather than a claim.

### 4. Typed handoffs, not transcripts

Stages communicate through `TaskState`, and each receives only a projection of it.

The review stage is the clearest case. It receives the task, the acceptance criteria, the
diff and the validation results. It does not receive the implementation stage's rationale,
its reasoning, or its self-assessment — so it cannot be persuaded by them. Independence is
a property of what the context contains.

The second-order effect is on revision cycles. A naive revision re-sends everything, so
cycle two costs more than cycle one and cycle three more again. Forge's revision prompt
carries the task, the criteria, the blocking findings and the failed criteria — and
deliberately **not** the cited code spans, which the builder read minutes earlier in the
same run.

### 5. Prefix stability for caching

Prompt caching is priced roughly an order of magnitude below base input on a read. That
makes cache hit ratio, not prompt size, the dominant lever on cost for an agent that runs
many turns.

Caching only helps if the prefix is byte-identical between turns. So:

- the system prompt is rendered **once** per stage and passed unchanged every turn
- the workspace profile is frozen at probe time, precisely so it cannot drift into the prefix
- the prompt renderer is pure: no timestamps, no turn counters, no unordered iteration
- everything that legitimately varies lives in the message list

And because this is easy to break by accident, Forge hashes the system prompt on every
request and reports **`prefixStable: false`** for any stage that rendered more than one
distinct prefix. A caching bug is otherwise invisible until it appears on a bill.

## Measuring it

Per-request telemetry records what actually happened:

```
contextVolume  = inputTokens + cacheCreationInputTokens + cacheReadInputTokens
cacheHitRatio  = cacheReadInputTokens / contextVolume
costUsd        = priced from a dated table checked into the repository
prefixStable   = did this stage render exactly one system prompt?
```

### The trap in most published agent-cost numbers

`inputTokens` is **the uncached remainder only**, not the whole prompt.

An agent that ran for an hour and reports 4,000 `inputTokens` served the rest from cache.
Reporting "total tokens" as `input + output` understates real context volume by an order
of magnitude in a well-cached agent and — perversely — makes a *badly* cached system look
leaner than a well-cached one.

Forge therefore reports `contextVolume` as the honest answer to "how much context did this
carry", alongside the cache hit ratio that explains why the cost is lower than that volume
implies.

### What would falsify the thesis

Worth stating, since a project that cannot be wrong is not making a claim:

- If `cacheHitRatio` stays low across stages despite stable prefixes, the handoff design is
  not doing what it claims.
- If citation accuracy is near 1.0 even without the checking mechanism, the mechanism is
  decorative.
- If most cost turns out to be irreducible — reading the code you must read, generating the
  diff you must generate — then context engineering is not where the savings are, and the
  honest conclusion is that model routing and caching carry the load instead.

The telemetry is designed to surface all three.
