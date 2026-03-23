import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { uploadFile, downloadFile, listRemoteFiles } from "../lib/ssh-client.js";
import { resolveServer } from "./registry.js";

export function registerFileTools(server: McpServer): void {
  // ── upload_file ───────────────────────────────────────────────────────────
  server.tool(
    "upload_file",
    "Upload a local file to a VPS server via SFTP",
    {
      server: z.string().min(1).describe("Server name as registered in the vault"),
      localPath: z.string().min(1).describe("Absolute path of the local file to upload"),
      remotePath: z.string().min(1).describe("Absolute path on the remote server where the file will be placed"),
    },
    async (args, extra) => {
      const log = async (msg: string) => {
        try { await server.sendLoggingMessage({ level: "info", data: msg }, extra.sessionId); } catch {}
      };
      try {
        const record = resolveServer(args.server);
        await log(`[${args.server}] Uploading ${args.localPath} → ${args.remotePath}`);
        await uploadFile(record, args.localPath, args.remotePath);
        return {
          content: [{ type: "text", text: `File uploaded: ${args.localPath} → ${args.server}:${args.remotePath}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── download_file ─────────────────────────────────────────────────────────
  server.tool(
    "download_file",
    "Download a file from a VPS server via SFTP to a local path",
    {
      server: z.string().min(1).describe("Server name as registered in the vault"),
      remotePath: z.string().min(1).describe("Absolute path of the file on the remote server"),
      localPath: z.string().min(1).describe("Absolute local path where the file will be saved"),
    },
    async (args, extra) => {
      const log = async (msg: string) => {
        try { await server.sendLoggingMessage({ level: "info", data: msg }, extra.sessionId); } catch {}
      };
      try {
        const record = resolveServer(args.server);
        await log(`[${args.server}] Downloading ${args.remotePath} → ${args.localPath}`);
        await downloadFile(record, args.remotePath, args.localPath);
        return {
          content: [{ type: "text", text: `File downloaded: ${args.server}:${args.remotePath} → ${args.localPath}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── list_remote_files ─────────────────────────────────────────────────────
  server.tool(
    "list_remote_files",
    "List files and directories at a remote path on a VPS server",
    {
      server: z.string().min(1).describe("Server name as registered in the vault"),
      remotePath: z.string().min(1).describe("Remote directory path to list"),
    },
    async (args, extra) => {
      const log = async (msg: string) => {
        try { await server.sendLoggingMessage({ level: "info", data: msg }, extra.sessionId); } catch {}
      };
      try {
        const record = resolveServer(args.server);
        await log(`[${args.server}] Listing ${args.remotePath}`);
        const entries = await listRemoteFiles(record, args.remotePath);
        return {
          content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
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
