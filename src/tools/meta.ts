import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CATEGORY_DESCRIPTIONS,
  createToolRegistry,
  findToolByName,
  listCategories,
  searchTools,
  toolInputJsonSchema,
  type ToolCategory,
  type ToolExtra,
} from "./registry-core.js";

const CATEGORY_VALUES = Object.keys(CATEGORY_DESCRIPTIONS) as [ToolCategory, ...ToolCategory[]];

const HOW_TO_USE = [
  "vps-mcp uses progressive tool discovery: only 4 meta-tools are listed.",
  "Workflow: 1) list_tool_categories to see what areas exist. 2) search_tools to find a tool by keyword or category. 3) get_tool_schemas to retrieve full input schemas. 4) invoke_tool to actually run a tool.",
].join(" ");

export function registerMetaTools(server: McpServer): void {
  // Pre-build registry once per McpServer instance (in HTTP mode that's per request).
  const registry = createToolRegistry();

  server.tool(
    "list_tool_categories",
    `List the categories of real tools exposed by this MCP server with counts and short descriptions. ${HOW_TO_USE}`,
    {},
    async () => {
      const categories = listCategories();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ categories, total_tools: registry.length }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "search_tools",
    `Search for tools by free-text query and/or category. Returns lightweight matches with name, category, and a one-line summary — NOT full schemas. Call get_tool_schemas next to retrieve the input schema of any tool you want to invoke. ${HOW_TO_USE}`,
    {
      query: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring matched against tool name, summary, description, and category"
        ),
      category: z
        .enum(CATEGORY_VALUES)
        .optional()
        .describe("Restrict to a single category (use list_tool_categories to discover them)"),
      limit: z.number().int().positive().max(100).default(20).describe("Max results (default 20)"),
    },
    async (args) => {
      const matches = searchTools({
        query: args.query,
        category: args.category,
        limit: args.limit,
      }).map((t) => ({
        name: t.name,
        category: t.category,
        summary: t.summary,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ matches }, null, 2) }],
      };
    }
  );

  server.tool(
    "get_tool_schemas",
    `Return full descriptions and JSON Schema input definitions for one or more tools by name. Call this once you have picked candidate tools via search_tools, before invoking them. ${HOW_TO_USE}`,
    {
      names: z
        .array(z.string().min(1))
        .min(1)
        .max(10)
        .describe("Tool names to fetch schemas for (1–10 at a time)"),
    },
    async (args) => {
      const tools: Array<{
        name: string;
        category: string;
        description: string;
        inputSchema: unknown;
      }> = [];
      const missing: string[] = [];
      for (const name of args.names) {
        const tool = findToolByName(name);
        if (!tool) {
          missing.push(name);
          continue;
        }
        tools.push({
          name: tool.name,
          category: tool.category,
          description: tool.description,
          inputSchema: toolInputJsonSchema(tool),
        });
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ tools, missing }, null, 2) }],
      };
    }
  );

  server.tool(
    "invoke_tool",
    `Execute one of the real tools by name. ${HOW_TO_USE} If you do not yet know the input schema for a tool, call get_tool_schemas first — invoke_tool validates arguments strictly against each tool's Zod schema.`,
    {
      name: z.string().min(1).describe("Tool name (as returned by search_tools)"),
      arguments: z
        .record(z.unknown())
        .optional()
        .describe("Arguments object matching the tool's inputSchema"),
    },
    async (args, mcpExtra) => {
      const tool = findToolByName(args.name);
      if (!tool) {
        return {
          content: [
            {
              type: "text",
              text: `Error: tool '${args.name}' not found. Call search_tools to discover available tools.`,
            },
          ],
          isError: true,
        };
      }

      const parsed = z.object(tool.inputSchema).safeParse(args.arguments ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `Error: invalid arguments for tool '${args.name}':\n${issues}\n\nCall get_tool_schemas({names:["${args.name}"]}) to see the expected input schema.`,
            },
          ],
          isError: true,
        };
      }

      const extra: ToolExtra = {
        sessionId: mcpExtra.sessionId,
        sendLog: async (msg: string) => {
          try {
            await server.sendLoggingMessage(
              { level: "info", data: msg },
              mcpExtra.sessionId
            );
          } catch {
            // Logging is best-effort.
          }
        },
      };

      return tool.handler(parsed.data, extra);
    }
  );
}
