import { execFileSync } from "node:child_process";

/**
 * Git operations.
 *
 * All deterministic, all invoked with `execFileSync` and an argument array so nothing
 * model-authored is ever interpolated into a shell string. Branch names in particular are
 * derived from a task id and then validated, because a branch name is the one piece of
 * git input that originates outside the program.
 */

const GIT_TIMEOUT_MS = 30_000;

/**
 * Paths kept out of every commit and diff.
 *
 * Forge writes telemetry into `.forge/` inside the repository it is working on. Without
 * this exclusion `git add -A` sweeps those artifacts into the change, so a pull request
 * carries the run's own logs alongside the fix — and the review stage pays to read them.
 * Lockfiles are excluded from diffs for the same reason: volume with no signal.
 */
const EXCLUDE_PATHSPEC = [":!.forge", ":!*.lock", ":!*-lock.json", ":!*.lockb"];

export class GitError extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Run git, throwing on failure. */
export function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new GitError(
      `git ${args[0]} failed: ${stderr.trim() || (error as Error).message}`,
      `git ${args.join(" ")}`,
    );
  }
}

/** Run git, returning null on failure. For probes where absence is a valid answer. */
export function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/** A branch name Forge is willing to create. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

/** Branches that must never be committed to directly. */
const PROTECTED = new Set(["main", "master", "develop", "trunk", "HEAD"]);

/**
 * Build a branch name from a task.
 *
 * Always prefixed, always slugged, always validated. The prefix makes Forge's branches
 * identifiable and cleanable, and the validation means a task title cannot smuggle
 * anything into a ref.
 */
export function branchNameFor(taskId: string, title: string, prefix = "forge"): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "task";
  const name = `${prefix}/${slug}-${taskId.slice(0, 8)}`;
  if (!SAFE_BRANCH.test(name)) throw new GitError(`Unsafe branch name: ${name}`, "branchNameFor");
  return name;
}

/** Refuse to operate on a protected branch. */
export function assertNotProtected(branch: string): void {
  const bare = branch.replace(/^refs\/heads\//, "");
  if (PROTECTED.has(bare)) {
    throw new GitError(
      `Refusing to commit directly to protected branch "${bare}".`,
      "assertNotProtected",
    );
  }
}

export function currentBranch(root: string): string {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function currentCommit(root: string): string {
  return git(root, ["rev-parse", "HEAD"]);
}

export function isRepository(root: string): boolean {
  return tryGit(root, ["rev-parse", "--git-dir"]) !== null;
}

/** True when the working tree has uncommitted changes. */
export function isDirty(root: string): boolean {
  return git(root, ["status", "--porcelain"]).length > 0;
}

/** Create and check out a branch from the current HEAD. */
export function createBranch(root: string, branch: string): void {
  assertNotProtected(branch);
  if (!SAFE_BRANCH.test(branch))
    throw new GitError(`Unsafe branch name: ${branch}`, "createBranch");
  git(root, ["checkout", "-b", branch]);
}

/**
 * Stage everything and commit.
 *
 * Returns null when there was nothing to commit, which is a normal outcome rather than an
 * error: a Builder that changed nothing should be caught by review, not by an exception.
 */
export function commitAll(root: string, message: string): string | null {
  assertNotProtected(currentBranch(root));
  git(root, ["add", "-A", "--", ".", ...EXCLUDE_PATHSPEC]);
  if (git(root, ["diff", "--cached", "--name-only"]).length === 0) return null;
  // Message via stdin-free argument array: no shell, so no quoting hazard.
  git(root, ["commit", "-m", message, "--no-verify"]);
  return currentCommit(root);
}

/** Diff of the working tree against a ref, including untracked files. */
export function diffWorkingTree(root: string, base: string): string {
  // Intent-to-add so new files appear in the diff, minus Forge's own artifacts.
  git(root, ["add", "-AN", "--", ".", ...EXCLUDE_PATHSPEC]);
  return git(root, ["diff", base, "--", ".", ...EXCLUDE_PATHSPEC]);
}

/** Push a branch to a remote. Refuses protected branches. */
export function pushBranch(root: string, branch: string, remote = "origin"): void {
  assertNotProtected(branch);
  if (!SAFE_BRANCH.test(branch)) throw new GitError(`Unsafe branch name: ${branch}`, "pushBranch");
  git(root, ["push", "--set-upstream", remote, branch]);
}

/** The remote's default branch, e.g. `main`. Falls back to the current branch. */
export function defaultBranch(root: string, remote = "origin"): string {
  const head = tryGit(root, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  if (head !== null) return head.replace(new RegExp(`^${remote}/`), "");
  return currentBranch(root);
}
