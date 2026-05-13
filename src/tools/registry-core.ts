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
  docs: "Scan a VPS environment and maintain per-server Markdown documentation",
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
