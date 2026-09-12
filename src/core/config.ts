import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Configuration.
 *
 * Kept small on purpose. Every option is one more thing a user must understand and one
 * more combination that can break, so an option earns its place only when a real
 * repository needs it to differ.
 *
 * Model routing is per stage because the stages have genuinely different needs: review
 * benefits from a different model than implementation, and implementation is where
 * capability matters most.
 */

const modelsSchema = z.object({
  investigate: z.string(),
  implement: z.string(),
  review: z.string(),
});

const limitsSchema = z.object({
  /** Model turns allowed within a single stage. */
  maxTurnsPerStage: z.number().int().positive(),
  /** Implementation/review cycles after the first. 0 disables revision. */
  maxRevisions: z.number().int().min(0),
  /** Per validation command, in milliseconds. */
  validationTimeoutMs: z.number().int().positive(),
  /** Abort the run if estimated spend exceeds this. 0 disables the cap. */
  maxCostUsd: z.number().min(0),
});

export const configSchema = z.object({
  models: modelsSchema,
  limits: limitsSchema,
  git: z.object({
    branchPrefix: z.string(),
    /** Commit automatically once validation passes. */
    autoCommit: z.boolean(),
  }),
  validation: z.object({
    /** Override discovery. Null means "use what the repository declares". */
    test: z.string().nullable(),
    lint: z.string().nullable(),
    typecheck: z.string().nullable(),
    build: z.string().nullable(),
  }),
});

export type ForgeConfig = z.infer<typeof configSchema>;

/**
 * Defaults.
 *
 * Review runs on a different model from implementation deliberately: a reviewer sharing
 * the implementer's model shares its blind spots, and the disagreements are the point.
 */
export const DEFAULT_CONFIG: ForgeConfig = {
  models: {
    investigate: "claude-sonnet-5",
    implement: "claude-opus-5",
    review: "claude-sonnet-5",
  },
  limits: {
    maxTurnsPerStage: 30,
    maxRevisions: 2,
    validationTimeoutMs: 600_000,
    maxCostUsd: 0,
  },
  git: {
    branchPrefix: "forge",
    autoCommit: true,
  },
  validation: {
    test: null,
    lint: null,
    typecheck: null,
    build: null,
  },
};

export const CONFIG_FILENAME = "forge.config.json";

/**
 * Load configuration, merging a repository's `forge.config.json` over the defaults.
 *
 * A malformed config is an error rather than a silent fallback: running with settings the
 * user believes are different from the ones in force is worse than refusing to start.
 */
export function loadConfig(root: string): ForgeConfig {
  const path = join(root, CONFIG_FILENAME);
  if (!existsSync(path)) return DEFAULT_CONFIG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${(error as Error).message}`);
  }

  const merged = deepMerge(DEFAULT_CONFIG as unknown as JsonObject, parsed as JsonObject);
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${CONFIG_FILENAME} is invalid:\n${issues}`);
  }
  return result.data;
}

type JsonObject = Record<string, unknown>;

/** Merge plain objects recursively. Arrays and primitives are replaced, not merged. */
function deepMerge(base: JsonObject, override: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The starter config written by `forge init`. */
export function starterConfig(): string {
  return `${JSON.stringify(
    {
      $schema:
        "https://raw.githubusercontent.com/kuldeepsinh19/forge/main/schema/forge.config.schema.json",
      models: DEFAULT_CONFIG.models,
      limits: { maxRevisions: DEFAULT_CONFIG.limits.maxRevisions },
      validation: {
        test: null,
        lint: null,
        typecheck: null,
        build: null,
      },
    },
    null,
    2,
  )}\n`;
}
