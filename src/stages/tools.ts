import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveInsideRoot } from "../retrieval/evidence.js";
import {
  grep,
  listFiles,
  readFileWindow,
  recentlyChangedFiles,
  searchHistory,
} from "../retrieval/search.js";
import type { ToolDefinition } from "../provider/types.js";

/**
 * The tool surface offered to reasoning stages.
 *
 * Two deliberate constraints:
 *
 * - **Surfaces are scoped per stage.** The Investigator gets read-only tools; only the
 *   Builder can write. Schemas are re-sent on every turn, so an unused tool is a tax
 *   paid on every request of that stage.
 * - **Every result is bounded.** Search caps matches, reads window the file, and the
 *   diff excludes lockfiles. An unbounded tool result is the most common way an agent's
 *   context silently explodes.
 */

/** Executes a tool call against a workspace. */
export type ToolExecutor = (input: Record<string, unknown>) => string;

export interface Tool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Read-only inspection tools. Available to every stage. */
export function readOnlyTools(root: string): Tool[] {
  return [
    {
      definition: {
        name: "search_code",
        description:
          "Search file contents with a regular expression. Returns up to 60 matches as " +
          "path:line:text. Use this before reading files: it is far cheaper than reading " +
          "a file to find out it is irrelevant.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regular expression to search for." },
            glob: {
              type: "string",
              description: "Optional file filter, e.g. '*.ts' or 'src/**/*.py'.",
            },
          },
          required: ["pattern"],
        },
      },
      execute: (input) => {
        const matches = grep(root, str(input["pattern"]), str(input["glob"]) || undefined);
        if (matches.length === 0) return "No matches.";
        return matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
      },
    },
    {
      definition: {
        name: "read_file",
        description:
          "Read a window of a file with 1-indexed line numbers. Defaults to the first 400 " +
          "lines. Cite the line numbers this returns; they are the ones that will be checked.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repository-relative path." },
            start_line: { type: "number", description: "1-indexed first line. Default 1." },
            end_line: { type: "number", description: "1-indexed last line, inclusive." },
          },
          required: ["path"],
        },
      },
      execute: (input) => {
        const path = str(input["path"]);
        const start = num(input["start_line"], 1);
        const endRaw = input["end_line"];
        const result = readFileWindow(
          root,
          path,
          start,
          typeof endRaw === "number" ? endRaw : undefined,
        );
        if (result === null) return `Cannot read ${path}: not found or outside the repository.`;
        return `${path} (${result.totalLines} lines total)\n\n${result.content}`;
      },
    },
    {
      definition: {
        name: "list_files",
        description:
          "List tracked files, optionally filtered by a glob. Respects the repository's " +
          "ignore rules.",
        inputSchema: {
          type: "object",
          properties: {
            glob: { type: "string", description: "Optional filter, e.g. 'src/**/*.ts'." },
          },
        },
      },
      execute: (input) => {
        const files = listFiles(root, str(input["glob"]) || undefined);
        if (files.length === 0) return "No files matched.";
        const shown = files.slice(0, 300);
        const suffix =
          files.length > shown.length ? `\n… and ${files.length - shown.length} more` : "";
        return shown.join("\n") + suffix;
      },
    },
    {
      definition: {
        name: "search_history",
        description:
          "Find commits whose diff added or removed a string (git log -S). The fastest way " +
          "to answer 'when did this change and why'.",
        inputSchema: {
          type: "object",
          properties: {
            needle: { type: "string", description: "Literal string to trace through history." },
          },
          required: ["needle"],
        },
      },
      execute: (input) => {
        const commits = searchHistory(root, str(input["needle"]));
        return commits.length === 0 ? "No commits touched that string." : commits.join("\n");
      },
    },
    {
      definition: {
        name: "recent_changes",
        description: "Files touched by the most recent commits. A weak relevance signal.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => {
        const files = recentlyChangedFiles(root);
        return files.length === 0 ? "No recent changes found." : files.join("\n");
      },
    },
  ];
}

/**
 * Write tools. Available only to the Builder.
 *
 * `write_file` replaces a whole file rather than patching. That is a deliberate
 * simplification: whole-file writes cannot fail the way fuzzy patch application does,
 * and the resulting diff is produced by git rather than by the model, so the change
 * summary and the actual change cannot drift apart.
 */
export function writeTools(root: string): Tool[] {
  return [
    {
      definition: {
        name: "write_file",
        description:
          "Write a file, replacing its entire contents. Creates parent directories. Read " +
          "the file first unless you are creating it: this replaces, it does not merge.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repository-relative path." },
            content: { type: "string", description: "The complete new file contents." },
          },
          required: ["path", "content"],
        },
      },
      execute: (input) => {
        const path = str(input["path"]);
        const resolved = resolveInsideRoot(root, path);
        if (resolved === null) return `Refused: ${path} is outside the repository.`;
        const content = str(input["content"]);
        try {
          mkdirSync(dirname(resolved), { recursive: true });
          writeFileSync(resolved, content, "utf8");
          const lines = content.split(/\r?\n/).length;
          return `Wrote ${path} (${lines} lines).`;
        } catch (error) {
          return `Failed to write ${path}: ${(error as Error).message}`;
        }
      },
    },
  ];
}

/** Turn a tool list into the map the agent loop dispatches through. */
export function toolMap(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((tool) => [tool.definition.name, tool]));
}

/** Just the schemas, for the provider call. */
export function definitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((tool) => tool.definition);
}
