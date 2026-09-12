import { execFileSync } from "node:child_process";
import type { TaskState } from "../core/types.js";
import { tryGit } from "../git/workspace.js";

/**
 * Pull request creation.
 *
 * Deterministic end to end. The body is assembled from {@link TaskState} — the fields the
 * stages already produced — rather than asked of a model, so what the pull request claims
 * and what the pipeline actually did cannot drift apart.
 *
 * Authentication is by token, resolved from the environment or from the `gh` CLI. The
 * token is never written to disk, never logged, and never placed in a prompt.
 */

/** Where a repository lives on GitHub. */
export interface RepoSlug {
  owner: string;
  repo: string;
}

export class PullRequestError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "PullRequestError";
  }
}

/**
 * Parse `owner/repo` out of a git remote URL.
 *
 * Handles the three forms in normal use: HTTPS, SSH, and the `ssh://` variant. Returns
 * null for anything that is not GitHub, so a GitLab or self-hosted remote degrades to
 * "no pull request" rather than a confusing API failure.
 */
export function parseRemote(url: string): RepoSlug | null {
  const cleaned = url.trim().replace(/\.git$/, "");
  const patterns = [
    /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+)$/,
    /^git@github\.com:([^/]+)\/([^/]+)$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(cleaned);
    if (match?.[1] && match[2]) return { owner: match[1], repo: match[2] };
  }
  return null;
}

/** Resolve the GitHub slug for a working tree, or null when there is not one. */
export function resolveRepoSlug(root: string, remote = "origin"): RepoSlug | null {
  const url = tryGit(root, ["remote", "get-url", remote]);
  return url === null ? null : parseRemote(url);
}

/**
 * Find a GitHub token.
 *
 * `GITHUB_TOKEN` first, then the `gh` CLI's own token so an already-authenticated machine
 * needs no extra setup. Returns null rather than throwing: callers decide whether the
 * absence of a token is fatal.
 */
export function resolveToken(): string | null {
  const fromEnv = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  try {
    const fromCli = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return fromCli === "" ? null : fromCli;
  } catch {
    return null;
  }
}

export interface CreatePullRequestOptions {
  slug: RepoSlug;
  token: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface PullRequest {
  number: number;
  url: string;
}

/**
 * Open a pull request through the REST API.
 *
 * Uses `fetch` rather than an SDK: one endpoint does not justify a dependency, and it
 * keeps the runtime dependency list at two packages.
 */
export async function createPullRequest(options: CreatePullRequestOptions): Promise<PullRequest> {
  const { owner, repo } = options.slug;
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "forge-agent",
    },
    body: JSON.stringify({
      title: options.title,
      head: options.head,
      base: options.base,
      body: options.body,
      draft: options.draft,
      maintainer_can_modify: true,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // 403 on a fine-grained token almost always means missing pull-request write.
    const hint =
      response.status === 401 || response.status === 403
        ? "The token needs `repo` scope (classic) or pull-request write (fine-grained)."
        : response.status === 422
          ? "GitHub rejected the request: the branch may not be pushed, or a pull request may already exist for it."
          : undefined;
    throw new PullRequestError(
      `GitHub returned ${response.status} creating the pull request: ${truncate(detail)}`,
      hint,
    );
  }

  const created = (await response.json()) as { number: number; html_url: string };
  return { number: created.number, url: created.html_url };
}

/** Fetch an issue so it can be used as a task. Read-only. */
export async function fetchIssue(
  slug: RepoSlug,
  token: string,
  issueNumber: number,
): Promise<{ title: string; body: string }> {
  const { owner, repo } = slug;
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "forge-agent",
      },
    },
  );
  if (!response.ok) {
    throw new PullRequestError(
      `GitHub returned ${response.status} fetching issue #${issueNumber}.`,
      response.status === 404
        ? "Check the issue number and that the token can read this repository."
        : undefined,
    );
  }
  const issue = (await response.json()) as { title: string; body: string | null };
  return { title: issue.title, body: issue.body ?? "" };
}

/**
 * Build the pull request body from the run's own state.
 *
 * Every section is derived from a field a stage produced. Nothing here is generated
 * prose, so the description cannot claim something the pipeline did not do.
 */
export function renderPullRequestBody(
  state: TaskState,
  options: { citationAccuracy: number; closesIssue?: number } = { citationAccuracy: 1 },
): string {
  const out: string[] = [];

  out.push("## What this changes", "");
  out.push(state.investigation?.problemStatement ?? state.task.title, "");

  if (state.investigation) {
    out.push("## Root cause", "", state.investigation.rootCause, "");

    if (state.investigation.evidence.length > 0) {
      out.push("<details>", "<summary>Evidence</summary>", "");
      out.push(
        "Each citation was verified against the tree at the base commit before the change.",
        "",
      );
      for (const item of state.investigation.evidence) {
        const refs = item.citations
          .map((c) =>
            c.startLine === c.endLine
              ? `\`${c.file}:${c.startLine}\``
              : `\`${c.file}:${c.startLine}-${c.endLine}\``,
          )
          .join(", ");
        out.push(`- ${item.claim} — ${refs}`);
      }
      out.push("", "</details>", "");
    }
  }

  if (state.implementation) {
    out.push("## Changes", "");
    for (const change of state.implementation.changes) {
      out.push(`- \`${change.path}\` — ${change.rationale}`);
    }
    out.push("");
    if (state.implementation.deviations.length > 0) {
      out.push("**Deviations from the plan**", "");
      for (const d of state.implementation.deviations) out.push(`- ${d}`);
      out.push("");
    }
  }

  out.push("## Validation", "");
  if (state.validations.length === 0) {
    out.push("No validation commands were discoverable in this repository, so none were run.", "");
  } else {
    out.push("| Check | Command | Result |", "|---|---|---|");
    for (const v of state.validations) {
      out.push(
        `| ${v.kind} | \`${v.command}\` | ${v.passed ? "pass" : `**fail** (exit ${v.exitCode})`} |`,
      );
    }
    out.push("");
  }

  if (state.review) {
    out.push("## Independent review", "");
    out.push(
      `Verdict: **${state.review.verdict}**. The review stage saw the task, the acceptance ` +
        `criteria, the diff and the validation output — not the implementation stage's reasoning.`,
      "",
    );
    out.push("| Acceptance criterion | Result |", "|---|---|");
    for (const c of state.review.criteriaResults) {
      out.push(`| ${escapePipes(c.criterion)} | ${c.pass ? "pass" : "**fail**"} |`);
    }
    out.push("");
    if (state.review.blockingFindings.length > 0) {
      out.push("**Blocking findings**", "");
      for (const f of state.review.blockingFindings) out.push(`- ${f}`);
      out.push("");
    }
    if (state.review.suggestions.length > 0) {
      out.push("<details>", "<summary>Non-blocking suggestions</summary>", "");
      for (const s of state.review.suggestions) out.push(`- ${s}`);
      out.push("", "</details>", "");
    }
  }

  const risks: string[] = [];
  if (state.implementation?.knownLimitations.length) {
    risks.push(...state.implementation.knownLimitations);
  }
  if (state.investigation?.assumptions.length) {
    risks.push(...state.investigation.assumptions.map((a) => `Assumption: ${a}`));
  }
  if (options.citationAccuracy < 1) {
    risks.push(
      `${Math.round((1 - options.citationAccuracy) * 100)}% of investigation claims were ` +
        `discarded because their citations did not resolve.`,
    );
  }
  if (state.revisionCount > 0) {
    risks.push(`Took ${state.revisionCount} revision cycle(s) to pass review.`);
  }
  if (risks.length > 0) {
    out.push("## Remaining risks", "");
    for (const r of risks) out.push(`- ${r}`);
    out.push("");
  }

  if (options.closesIssue !== undefined) out.push(`Closes #${options.closesIssue}`, "");

  out.push("---", "");
  out.push(
    "Opened by [Forge](https://github.com/kuldeepsinh19/forge). Review the diff before merging.",
  );

  return out.join("\n");
}

/** Title for the pull request. Kept short and derived from the task. */
export function renderPullRequestTitle(state: TaskState): string {
  const title = state.task.title.trim();
  return title.length > 72 ? `${title.slice(0, 69)}...` : title;
}

const escapePipes = (text: string): string => text.replace(/\|/g, "\\|");

function truncate(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}
