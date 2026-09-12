# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
major version is 0, the public API may change in a minor release.

## [Unreleased]

## [0.1.0]

First release. The pipeline runs end to end; it has not yet been evaluated at scale.

### Added

- **Three-stage pipeline** — investigate, implement, review — sequenced by ordinary
  control flow rather than an orchestrating agent.
- **Citation checking.** Investigation claims cite a file and line range, verified against
  the working tree. Claims whose citations do not resolve are discarded before they reach
  the next stage.
- **Deterministic workspace probe.** Languages, package manager, source and test
  directories, and validation commands read from the repository's own configuration.
  Probed once and frozen so the cached prompt prefix stays stable.
- **Deterministic validation.** Runs the repository's own typecheck, lint, test and build
  commands. Exit codes decide pass or fail; no model is asked.
- **Structurally independent review.** The review stage receives the task, the acceptance
  criteria, the real diff and the validation results, and never the implementation
  stage's reasoning. Approving with blocking findings, or with failing validation, is
  downgraded in code.
- **Per-request telemetry.** Every model call records tokens with cache reads and writes
  separated, the resolved model, stage, latency, a system-prompt hash and priced cost,
  written before the response is consumed. Reports `contextVolume`, `cacheHitRatio` and
  `prefixStable` per stage.
- **Cost accounting** against a dated price table checked into the repository, with
  per-model cache multipliers, recomputable offline from stored usage.
- **Bounded revision cycles**, configurable and defaulting to two.
- **Git safety.** Branch names generated and validated against an allowlist; `main`,
  `master`, `develop`, `trunk` and `HEAD` refused in code; all git calls made with
  argument arrays rather than shell strings.
- **CLI** — `forge run`, `forge init`, `forge inspect`, with `--dry-run`, `--task-file`,
  `--json` and `--repo`.
- **Anthropic provider** behind a `ModelProvider` seam that requires a telemetry context
  on every call.

### Known limitations

- No sandboxing. Forge runs the target repository's commands with the privileges of the
  invoking user. Run untrusted repositories in a container. See [SECURITY.md](SECURITY.md).
- No pull request creation yet; runs end at a committed branch.
- Anthropic is the only implemented provider.
- No published evaluation results. The methodology is written up in
  `docs/research/evaluation-strategy.md`; the numbers are not yet measured.

[Unreleased]: https://github.com/kuldeepsinh19/forge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kuldeepsinh19/forge/releases/tag/v0.1.0
