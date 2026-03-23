import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRegistryTools } from "./tools/registry.js";
import { registerSshTools } from "./tools/ssh.js";
import { registerFileTools } from "./tools/files.js";
import { registerDeployTools } from "./tools/deploy.js";
import { registerDocsTools } from "./tools/docs.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "vps-mcp",
    version: "1.0.0",
  });

  registerRegistryTools(server);
  registerSshTools(server);
  registerFileTools(server);
  registerDeployTools(server);
  registerDocsTools(server);

  return server;
}
