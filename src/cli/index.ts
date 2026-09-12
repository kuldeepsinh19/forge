#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { CONFIG_FILENAME, loadConfig, starterConfig } from "../core/config.js";
import { run, type PipelineEvent } from "../core/pipeline.js";
import type { Task } from "../core/types.js";
import { fetchIssue, resolveRepoSlug, resolveToken } from "../github/pr.js";
import { probeWorkspace } from "../retrieval/workspace.js";
import { formatSummary } from "../telemetry/recorder.js";
import { formatValidation } from "../validate/runner.js";

/**
 * The command line interface.
 *
 * Uses Node's built-in `parseArgs` rather than a dependency: the surface is three
 * commands, and a CLI framework would be more code than the CLI.
 */

const USAGE = `forge — context-efficient AI agents for software engineering

Usage:
  forge run <task>            Investigate, implement, validate and review a task
  forge init                  Write a starter ${CONFIG_FILENAME}
  forge inspect               Show what Forge detects about this repository

Options for \`run\`:
  --repo <path>       Repository to work in (default: current directory)
  --dry-run           Investigate only; write nothing
  --task-file <path>  Read the task description from a file instead of the argument
  --issue <number>    Take the task from a GitHub issue on this repository's origin
  --pr                Push the branch and open a pull request once review approves
  --no-pr             Never open a pull request, overriding the config
  --max-cost <usd>    Abort the run once recorded spend reaches this
  --run-dir <path>    Where to write telemetry (default: .forge/runs/<timestamp>)
  --no-telemetry      Do not write a run directory
  --json              Emit machine-readable JSON on stdout
  --quiet             Suppress progress output

Environment:
  GITHUB_TOKEN        Needed for --issue and --pr. Falls back to gh auth token.
  ANTHROPIC_API_KEY   Required for \`run\`.

Examples:
  forge run "Users can submit the checkout form twice on a slow network"
  forge run --dry-run --task-file bug.md
  forge run --issue 42 --pr
  forge inspect
`;

interface Cli {
  command: string;
  positionals: string[];
  values: Record<string, unknown>;
}

function parse(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "task-file": { type: "string" },
      issue: { type: "string" },
      pr: { type: "boolean" },
      "no-pr": { type: "boolean" },
      "max-cost": { type: "string" },
      "run-dir": { type: "string" },
      "no-telemetry": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  return { command: positionals[0] ?? "", positionals: positionals.slice(1), values };
}

async function main(): Promise<number> {
  let cli: Cli;
  try {
    cli = parse(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  // Checked before the empty-command case: `forge --version` has no positional.
  if (cli.values["version"]) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (cli.values["help"] || cli.command === "" || cli.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = resolve(typeof cli.values["repo"] === "string" ? cli.values["repo"] : process.cwd());

  switch (cli.command) {
    case "init":
      return commandInit(root);
    case "inspect":
      return commandInspect(root);
    case "run":
      return commandRun(cli, root);
    default:
      process.stderr.write(`Unknown command: ${cli.command}\n\n${USAGE}`);
      return 2;
  }
}

function commandInit(root: string): number {
  const path = join(root, CONFIG_FILENAME);
  if (existsSync(path)) {
    process.stderr.write(`${CONFIG_FILENAME} already exists. Leaving it alone.\n`);
    return 1;
  }
  writeFileSync(path, starterConfig(), "utf8");
  process.stdout.write(
    `Created ${CONFIG_FILENAME}.\n\n` +
      `Next: set ANTHROPIC_API_KEY, then try\n  forge run --dry-run "describe a bug here"\n`,
  );
  return 0;
}

/** Show what the deterministic probe finds. Costs nothing and calls no model. */
function commandInspect(root: string): number {
  const profile = probeWorkspace(root);
  const lines: string[] = [];
  lines.push(`Repository: ${root}`, "");
  lines.push(`  Languages       ${profile.languages.join(", ") || "(none detected)"}`);
  lines.push(`  Package manager ${profile.packageManager ?? "(none detected)"}`);
  lines.push(`  Source dirs     ${profile.sourceDirs.join(", ") || "(none)"}`);
  lines.push(`  Test dirs       ${profile.testDirs.join(", ") || "(none)"}`);
  lines.push(`  Project files   ${profile.markers.join(", ") || "(none)"}`);
  lines.push("");
  lines.push("  Validation commands discovered from this repository:");
  const commands = Object.entries(profile.commands);
  const found = commands.filter(([, value]) => value !== null);
  if (found.length === 0) {
    lines.push("    (none — validation will be skipped)");
  } else {
    for (const [kind, command] of found) lines.push(`    ${kind.padEnd(10)} ${command}`);
  }
  if (profile.instructions) {
    lines.push(
      "",
      `  Repository instructions: found (${profile.instructions.length} chars, treated as untrusted)`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function commandRun(cli: Cli, root: string): Promise<number> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    process.stderr.write("ANTHROPIC_API_KEY is not set.\n");
    return 2;
  }

  let config;
  try {
    config = loadConfig(root);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  // Flags override the config file, so a one-off run does not need it edited.
  if (cli.values["pr"] === true) config.github.createPullRequest = true;
  if (cli.values["no-pr"] === true) config.github.createPullRequest = false;
  const maxCost = cli.values["max-cost"];
  if (typeof maxCost === "string") {
    const parsed = Number(maxCost);
    if (!Number.isFinite(parsed) || parsed < 0) {
      process.stderr.write(`--max-cost must be a non-negative number, got "${maxCost}".\n`);
      return 2;
    }
    config.limits.maxCostUsd = parsed;
  }

  const taskFile = cli.values["task-file"];
  const issueArg = cli.values["issue"];
  let task: Task;

  if (typeof issueArg === "string") {
    const issueNumber = Number(issueArg);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      process.stderr.write(`--issue must be a positive integer, got "${issueArg}".\n`);
      return 2;
    }
    const slug = resolveRepoSlug(root, config.github.remote);
    if (slug === null) {
      process.stderr.write(
        `Remote "${config.github.remote}" is not a GitHub repository, so --issue cannot be used.\n`,
      );
      return 2;
    }
    const token = resolveToken();
    if (token === null) {
      process.stderr.write("No GitHub token. Set GITHUB_TOKEN or run `gh auth login`.\n");
      return 2;
    }
    try {
      const issue = await fetchIssue(slug, token, issueNumber);
      task = {
        id: randomUUID(),
        title: issue.title,
        // The issue body verbatim. It is untrusted content, and the stages treat it so.
        body: issue.body.trim() === "" ? issue.title : issue.body,
        source: "github-issue",
        sourceRef: String(issueNumber),
      };
      if (!quietFor(cli)) {
        process.stderr.write(
          `  Task from ${slug.owner}/${slug.repo}#${issueNumber}: ${issue.title}\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 2;
    }
  } else {
    let body: string;
    if (typeof taskFile === "string") {
      if (!existsSync(taskFile)) {
        process.stderr.write(`Task file not found: ${taskFile}\n`);
        return 2;
      }
      body = readFileSync(taskFile, "utf8").trim();
    } else {
      body = cli.positionals.join(" ").trim();
    }
    if (body === "") {
      process.stderr.write(`No task given.\n\n${USAGE}`);
      return 2;
    }
    task = {
      id: randomUUID(),
      title: firstLine(body),
      body,
      source: typeof taskFile === "string" ? "file" : "cli",
    };
  }

  const quiet = cli.values["quiet"] === true || cli.values["json"] === true;
  const runDir =
    cli.values["no-telemetry"] === true
      ? undefined
      : typeof cli.values["run-dir"] === "string"
        ? cli.values["run-dir"]
        : join(root, ".forge", "runs", new Date().toISOString().replace(/[:.]/g, "-"));

  const onEvent = (event: PipelineEvent): void => {
    if (quiet) return;
    const prefix =
      event.type === "stage-start"
        ? "\n▸ "
        : event.type === "warning"
          ? "  ! "
          : event.type === "tool"
            ? "    · "
            : "  ";
    process.stderr.write(`${prefix}${event.message}\n`);
  };

  try {
    const result = await run({
      task,
      root,
      config,
      apiKey,
      ...(runDir ? { runDir } : {}),
      dryRun: cli.values["dry-run"] === true,
      onEvent,
    });

    if (cli.values["json"] === true) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(renderReport(result));
    }
    return result.state.status === "approved" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`\nRun failed: ${(error as Error).message}\n`);
    return 1;
  }
}

function renderReport(result: Awaited<ReturnType<typeof run>>): string {
  const { state, telemetry } = result;
  const lines: string[] = ["", "─".repeat(62), ""];

  lines.push(`  Status      ${state.status}`);
  if (state.branch) lines.push(`  Branch      ${state.branch}`);
  if (state.investigation) {
    lines.push(`  Root cause  ${state.investigation.rootCause}`);
    lines.push(
      `  Evidence    ${state.investigation.evidence.length} grounded claim(s), ` +
        `${(result.citationAccuracy * 100).toFixed(0)}% of citations resolved`,
    );
  }
  if (state.implementation) {
    lines.push(`  Changed     ${state.implementation.changes.map((c) => c.path).join(", ")}`);
  }
  lines.push(`  Validation  ${formatValidation(state.validations)}`);
  if (result.pullRequest) {
    lines.push(`  Pull req    #${result.pullRequest.number} ${result.pullRequest.url}`);
  }

  if (state.review) {
    const passed = state.review.criteriaResults.filter((c) => c.pass).length;
    lines.push(
      `  Review      ${state.review.verdict} — ${passed}/${state.review.criteriaResults.length} criteria`,
    );
    for (const finding of state.review.blockingFindings) lines.push(`              ✗ ${finding}`);
  }

  lines.push(formatSummary(telemetry));

  if (state.warnings.length > 0) {
    lines.push("", "  Warnings:");
    for (const warning of state.warnings) lines.push(`    - ${warning}`);
  }
  if (result.runDir) lines.push("", `  Telemetry written to ${result.runDir}`);
  lines.push("");
  return lines.join("\n");
}

/** Whether progress output is suppressed. Needed before the main `quiet` is computed. */
function quietFor(cli: Cli): boolean {
  return cli.values["quiet"] === true || cli.values["json"] === true;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "Untitled task";
  return line
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 120);
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  });
