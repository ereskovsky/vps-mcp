import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getRegistryTools } from "./registry.js";
import { getSshTools } from "./ssh.js";
import { getSessionTools } from "./sessions.js";
import { getFileTools } from "./files.js";
import { getDeployTools } from "./deploy.js";
import { getDocsTools } from "./docs.js";

export type ToolCategory = "registry" | "ssh" | "sessions" | "files" | "deploy" | "docs";

export const CATEGORY_DESCRIPTIONS: Record<ToolCategory, string> = {
  registry: "Manage registered VPS servers in the encrypted vault (list, add, remove)",
  ssh: "Execute single bash scripts on a VPS over SSH (one-shot, fresh connection each call)",
  sessions: "Open a persistent SSH shell for sequences of commands with state (cwd/env) preserved between calls",
  files: "Transfer files and directory listings between the MCP host, public URLs, and a VPS",
  deploy: "Docker container operations and application deployment workflows on a VPS",
  docs: "Snapshot a registered VPS with scan_server and maintain per-server Markdown documentation",
};

export type ToolExtra = {
  sessionId?: string;
  sendLog: (msg: string) => Promise<void>;
};

export type ToolHandler<Args extends z.ZodRawShape> = (
  args: z.infer<z.ZodObject<Args>>,
  extra: ToolExtra
) => Promise<CallToolResult>;

export type ToolDef<Args extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  category: ToolCategory;
  summary: string;
  description: string;
  inputSchema: Args;
  handler: ToolHandler<Args>;
};

export function defineTool<Args extends z.ZodRawShape>(
  spec: ToolDef<Args>
): ToolDef {
  return spec as unknown as ToolDef;
}

let cachedRegistry: ToolDef[] | null = null;

export function createToolRegistry(): ToolDef[] {
  if (cachedRegistry) return cachedRegistry;
  cachedRegistry = [
    ...getRegistryTools(),
    ...getSshTools(),
    ...getSessionTools(),
    ...getFileTools(),
    ...getDeployTools(),
    ...getDocsTools(),
  ];
  return cachedRegistry;
}

export function findToolByName(name: string): ToolDef | undefined {
  return createToolRegistry().find((t) => t.name === name);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[m];
}

/**
 * Suggest the closest real tool names for a (likely hallucinated) query name.
 * Combines substring containment, shared underscore tokens, and edit distance
 * so that e.g. "scan_environment" resolves to "scan_server".
 */
export function suggestToolNames(query: string, limit = 5): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qTokens = q.split(/[_\s-]+/).filter(Boolean);
  return createToolRegistry()
    .map((t) => {
      const name = t.name.toLowerCase();
      const nameTokens = name.split("_");
      let score = 0;
      if (name === q) score += 100;
      if (name.includes(q) || q.includes(name)) score += 50;
      score += nameTokens.filter((p) => qTokens.includes(p)).length * 20;
      const dist = levenshtein(q, name);
      if (dist <= 3) score += (4 - dist) * 10;
      return { name: t.name, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.name);
}

/** All registered tool names with their category, for "available tools" hints. */
export function listAllToolNames(): Array<{ name: string; category: ToolCategory }> {
  return createToolRegistry().map((t) => ({ name: t.name, category: t.category }));
}

export function searchTools(opts: {
  query?: string;
  category?: ToolCategory;
  limit?: number;
}): ToolDef[] {
  const { query, category, limit = 20 } = opts;
  const q = query?.trim().toLowerCase();
  return createToolRegistry()
    .filter((t) => (category ? t.category === category : true))
    .filter((t) => {
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      );
    })
    .slice(0, limit);
}

export function toolInputJsonSchema(tool: ToolDef): unknown {
  return zodToJsonSchema(z.object(tool.inputSchema), {
    target: "jsonSchema7",
    $refStrategy: "none",
  });
}

export function listCategories(): Array<{
  name: ToolCategory;
  count: number;
  description: string;
}> {
  const counts = new Map<ToolCategory, number>();
  for (const tool of createToolRegistry()) {
    counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
  }
  return (Object.keys(CATEGORY_DESCRIPTIONS) as ToolCategory[]).map((name) => ({
    name,
    count: counts.get(name) ?? 0,
    description: CATEGORY_DESCRIPTIONS[name],
  }));
}
