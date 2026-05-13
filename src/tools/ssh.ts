import { z } from "zod";
import { execScript } from "../lib/ssh-client.js";
import { resolveServer } from "./registry.js";
import { defineTool, type ToolDef } from "./registry-core.js";

export function getSshTools(): ToolDef[] {
  return [
    defineTool({
      name: "execute_script",
      category: "ssh",
      summary: "Run one or more bash commands on a registered VPS over SSH (single-shot)",
      description:
        "Execute a bash script (one or more lines) on a VPS and return stdout, stderr, and exit code. " +
        "ALWAYS prefer this over making many small calls — batch related commands into one script (use newlines, &&, ;). " +
        "Each call opens a fresh SSH connection: 20 calls = 20 handshakes and 20 round-trips through the model context. " +
        "If you need state to persist between commands (cd, env vars, background processes) or expect to issue 5+ commands " +
        "against the same server, open a session_open instead and use session_exec.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        script: z
          .string()
          .min(1)
          .describe(
            "Bash script content. Single command or multiple lines — both work. Wrapped in `bash -c`."
          ),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          const lineCount = args.script.split("\n").length;
          await extra.sendLog(`[${args.server}] Running script (${lineCount} line${lineCount === 1 ? "" : "s"})`);
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
      },
    }),
  ];
}
