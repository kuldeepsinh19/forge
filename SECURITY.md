# Security

Forge reads a repository, writes files into it, and runs that repository's own commands.
That makes it a program that executes untrusted code by design. This document states what
it defends against, what it does not, and where the sharp edges are.

## Reporting a vulnerability

Please report privately rather than opening a public issue: use
[GitHub's private vulnerability reporting](https://github.com/kuldeepsinh19/forge/security/advisories/new)
on this repository. Include what you did, what happened, and what you expected. A first
response should come within a week.

Please do not include working exploits against third-party systems, and do not test
against repositories you do not own.

## Threat model

The core assumption: **everything inside the target repository is untrusted input.**

A repository can be authored by anyone. Its README, its source comments, its `AGENTS.md`,
its issue text and its test output all reach a model's context at some point. Any of them
can contain text engineered to redirect an agent.

| Actor | Trusted? | Notes |
|---|---|---|
| The person running Forge | Yes | They chose the repository and the task. |
| `forge.config.json` | Yes | Local configuration, written by that person. |
| Repository source, docs, `AGENTS.md` | **No** | Attacker-controlled in any repository you did not write. |
| Task text from an external source | **No** | An issue body can be written by anyone. |
| Model output | **No** | Treated as a proposal to be validated, never as a command. |

## What Forge does defend against

**Fabricated evidence.** Every citation the investigation stage produces is checked
against the working tree: the file must exist, the range must be within the file, and the
span must not be blank. Claims that fail are discarded rather than passed downstream. This
is the main defence against confident assertions about code that is not there.
(`src/retrieval/evidence.ts`)

**Path traversal.** Model-supplied paths are resolved against the repository root and
rejected if they escape it, including via `..` segments and absolute paths. This applies
to reads, writes and citations alike.

**Prompt injection via repository instructions.** `AGENTS.md` and `CLAUDE.md` are read,
truncated, fenced in `<repository-instructions>` tags, and explicitly labelled as
untrusted content that cannot change the task, the output contract, or safety constraints.
This raises the cost of an attack; it does not eliminate it. Treat it as defence in depth,
not a guarantee.

**Unsafe git operations.** Branch names are generated from a slug plus a run id and
validated against a conservative character allowlist. `main`, `master`, `develop`, `trunk`
and `HEAD` are refused in code, at branch creation, at commit and at push. A task title
cannot smuggle anything into a ref.

**Shell injection through git.** Every git call uses `execFileSync` with an argument
array. No model-authored string is ever interpolated into a shell command.

**Model-invented commands.** Validation commands come from the repository's own
configuration — `package.json` scripts, `Cargo.toml`, `go.mod`, `pyproject.toml` — or from
`forge.config.json`. A model cannot introduce a command to be executed.

**Unbounded context growth.** Search results, file reads and diffs are all capped. An
unbounded tool result is the usual way an agent's context, and its cost, explodes silently.

**Runaway spend.** Turns per stage and revision cycles are both bounded by configuration.

## What Forge does not defend against

These are real limitations, stated plainly rather than buried.

**Forge does not sandbox the code it runs.** `npm test` in the target repository executes
with the full privileges of the user running Forge: full filesystem access, full network
access, and access to every environment variable in the process, including
`ANTHROPIC_API_KEY`. A malicious repository's test script can do anything you can do.

> **Run Forge against untrusted repositories inside a container or VM, with no credentials
> in the environment beyond what it needs.** There is no configuration flag that makes this
> safe. Isolation is currently your responsibility.

**No network egress control.** Neither Forge nor the commands it runs are restricted from
reaching the network.

**Prompt injection is mitigated, not solved.** A sufficiently well-crafted payload in
repository content may still influence a model. The mitigations that matter most are
structural rather than textual: the review stage cannot be talked into approving by the
implementation stage because it never sees it, and citation checking is code rather than
persuasion.

**No secret scanning.** Forge does not detect or redact secrets it encounters in the
repository, and file contents it reads are sent to the model provider.

**Committed content is not vetted.** If the implementation stage writes a secret into a
file, Forge will commit it. Review your diffs.

## Credentials

`ANTHROPIC_API_KEY` is read from the environment and passed to the Anthropic SDK. It is
never written to disk, never included in a prompt, and never recorded in telemetry.

Telemetry records token counts, model ids, stage names, latency, cost and content
**hashes** — never prompt or response text.

A GitHub token is needed only for `--issue` and `--pr`. It is read from `GITHUB_TOKEN`
(or `gh auth token`), used for two REST calls, and never written to disk, logged, placed
in a prompt, or passed into the repository's own commands. It needs `repo` scope on a
classic token, or pull-request write on a fine-grained one.

A pull request is opened only when the review stage approves, and it is a draft by
default. Forge cannot merge: no merge call exists in the codebase.

## Reducing risk

- Run against untrusted repositories in a container or VM.
- Give the process a minimal environment: no cloud credentials, no SSH agent, no tokens
  beyond the model key.
- Use `--dry-run` first. It investigates and writes nothing.
- Keep `autoCommit` off if you want to inspect every change before it lands.
- Read the diff. Forge produces a branch, deliberately, and a human decides what merges.

## Supported versions

Forge is pre-1.0. Security fixes are applied to `main` and released as a new patch
version; older versions are not backported.
