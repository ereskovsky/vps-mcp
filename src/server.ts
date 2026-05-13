import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerDirectTools } from "./tools/register-direct.js";

export type RegistrationMode = "gateway" | "direct";

export function createServer(mode: RegistrationMode = "gateway"): McpServer {
  const server = new McpServer({
    name: "vps-mcp",
    version: "1.0.0",
  });

  if (mode === "direct") {
    registerDirectTools(server);
  } else {
    registerMetaTools(server);
  }

  return server;
}
