import { z } from "zod";
import { resolveServer } from "./registry.js";
import { defineTool, type ToolDef } from "./registry-core.js";
import {
  openSession,
  execInSession,
  closeSession,
  listSessions,
} from "../lib/ssh-session.js";

const SESSIONS_HOWTO =
  "Use sessions when you expect 3+ commands against the same server or need state (cwd, env, $?) to persist. " +
  "Workflow: session_open(server) → session_exec(id, command) × N → session_close(id).";

export function getSessionTools(): ToolDef[] {
  return [
    defineTool({
      name: "session_open",
      category: "sessions",
      summary: "Open a stateful SSH shell session on a registered VPS",
      description:
        "Open a persistent SSH shell on a VPS and return a session id. State (cwd, env vars, shell vars) " +
        "persists across subsequent session_exec calls on the same id — much faster than execute_script for sequences " +
        `of commands, and lets you do things like \`cd /opt/app && export FOO=bar\` once. ${SESSIONS_HOWTO} ` +
        "Sessions auto-close after 30 minutes idle. Max 10 concurrent sessions. Close with session_close when done.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          const id = await openSession(record);
          await extra.sendLog(`[${args.server}] Opened session ${id}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    sessionId: id,
                    server: args.server,
                    hint: "Run commands with session_exec({ sessionId, command }). Close with session_close.",
                  },
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

    defineTool({
      name: "session_exec",
      category: "sessions",
      summary: "Run a command inside an open SSH session (state persists)",
      description:
        "Execute a command (single-line or multi-line bash) inside a previously opened session. " +
        "State persists between calls: a `cd /tmp` here is visible to the next call on the same sessionId. " +
        "Only one command per session at a time (sessions are sequential). Returns stdout, stderr, exitCode.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Session id from session_open"),
        command: z.string().min(1).describe("Command or bash snippet to run"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(30 * 60 * 1000)
          .optional()
          .describe("Command timeout in milliseconds (default 300000 / 5 min, max 1800000 / 30 min)"),
      },
      handler: async (args, extra) => {
        try {
          await extra.sendLog(`[session ${args.sessionId}] $ ${args.command.split("\n")[0]}`);
          const result = await execInSession(args.sessionId, args.command, args.timeoutMs);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
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

    defineTool({
      name: "session_close",
      category: "sessions",
      summary: "Close an open SSH session and release the connection",
      description:
        "Close an SSH session opened with session_open. Idempotent — succeeds quietly if the id is unknown " +
        "(possibly already evicted by the 30-minute idle timeout).",
      inputSchema: {
        sessionId: z.string().min(1).describe("Session id from session_open"),
      },
      handler: async (args, extra) => {
        const closed = closeSession(args.sessionId);
        await extra.sendLog(`Session ${args.sessionId} ${closed ? "closed" : "not found"}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessionId: args.sessionId, closed }, null, 2),
            },
          ],
        };
      },
    }),

    defineTool({
      name: "session_list",
      category: "sessions",
      summary: "List currently open SSH sessions",
      description:
        "List all currently open SSH sessions (id, server, host, username, busy, createdAt, idleMs). " +
        "Useful if you lost track of session ids or want to reuse an existing session before opening a new one.",
      inputSchema: {},
      handler: async () => {
        const sessions = listSessions();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessions }, null, 2),
            },
          ],
        };
      },
    }),
  ];
}
