import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execCommand, execScript } from "../lib/ssh-client.js";
import { resolveServer } from "./registry.js";

export function registerSshTools(server: McpServer): void {
  // ── execute_command ───────────────────────────────────────────────────────
  server.tool(
    "execute_command",
    "Execute a shell command on a VPS server via SSH and return stdout, stderr, and exit code",
    {
      server: z.string().min(1).describe("Server name as registered in the vault"),
      command: z.string().min(1).describe("Shell command to execute"),
    },
    async (args, extra) => {
      const log = async (msg: string) => {
        try { await server.sendLoggingMessage({ level: "info", data: msg }, extra.sessionId); } catch {}
      };
      try {
        const record = resolveServer(args.server);
        await log(`[${args.server}] $ ${args.command}`);
        const result = await execCommand(record, args.command);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── execute_script ────────────────────────────────────────────────────────
  server.tool(
    "execute_script",
    "Execute a multiline bash script on a VPS server via SSH",
    {
      server: z.string().min(1).describe("Server name as registered in the vault"),
      script: z.string().min(1).describe("Bash script content (multiline supported)"),
    },
    async (args, extra) => {
      const log = async (msg: string) => {
        try { await server.sendLoggingMessage({ level: "info", data: msg }, extra.sessionId); } catch {}
      };
      try {
        const record = resolveServer(args.server);
        const lineCount = args.script.split("\n").length;
        await log(`[${args.server}] Running script (${lineCount} lines)...`);
        const result = await execScript(record, args.script);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
