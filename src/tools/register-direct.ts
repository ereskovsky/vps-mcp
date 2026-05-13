import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolRegistry, type ToolExtra } from "./registry-core.js";

/**
 * Register every real tool directly on the MCP server (no meta-gateway).
 *
 * Trade-off vs. registerMetaTools:
 *   - Cold context: ~5–10K tokens for 20 tool schemas vs. ~1K for 4 meta-tools.
 *   - Per-call overhead: ~30–50 tokens saved (no `invoke_tool` wrapper),
 *     and the LLM skips the search_tools/get_tool_schemas discovery dance.
 *
 * Used for local clients (stdio / Claude Code) where the context budget is
 * roomy and the latency-per-call matters. HTTP / Claude.ai keeps the gateway
 * to stay light on the wire for the web client's listing.
 */
export function registerDirectTools(server: McpServer): void {
  const tools = createToolRegistry();
  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema,
      async (args, mcpExtra) => {
        const extra: ToolExtra = {
          sessionId: mcpExtra.sessionId,
          sendLog: async (msg: string) => {
            try {
              await server.sendLoggingMessage(
                { level: "info", data: msg },
                mcpExtra.sessionId
              );
            } catch {
              // best-effort
            }
          },
        };
        return tool.handler(args as never, extra);
      }
    );
  }
}
