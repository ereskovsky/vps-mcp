import { z } from "zod";
import {
  uploadFile,
  downloadFile,
  listRemoteFiles,
  writeFileContent,
  readFileContent,
  execCommand,
} from "../lib/ssh-client.js";
import { resolveServer } from "./registry.js";
import { defineTool, type ToolDef } from "./registry-core.js";

const INLINE_DOWNLOAD_HARD_CAP = 5 * 1024 * 1024; // 5 MB
const INLINE_DOWNLOAD_DEFAULT = 1 * 1024 * 1024; // 1 MB

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function getFileTools(): ToolDef[] {
  return [
    defineTool({
      name: "upload_file",
      category: "files",
      summary: "Upload a local file from the MCP host to a VPS via SFTP",
      description:
        "Upload a file from the MCP server's local filesystem to a VPS via SFTP. NOTE: in HTTP/remote mode 'localPath' refers to the filesystem of the VPS hosting the MCP server itself, NOT the user's machine. To transfer files from the user's machine, use upload_file_content (small files) or the HTTP POST /files/upload endpoint (large files).",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        localPath: z.string().min(1).describe("Absolute path on the MCP server's filesystem"),
        remotePath: z.string().min(1).describe("Absolute path on the target VPS"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          await extra.sendLog(`[${args.server}] Uploading ${args.localPath} → ${args.remotePath}`);
          await uploadFile(record, args.localPath, args.remotePath);
          return {
            content: [
              {
                type: "text",
                text: `File uploaded: ${args.localPath} → ${args.server}:${args.remotePath}`,
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
      name: "download_file",
      category: "files",
      summary: "Download a remote file from a VPS to the MCP host via SFTP",
      description:
        "Download a file from a VPS to the MCP server's local filesystem via SFTP. NOTE: in HTTP/remote mode 'localPath' is the filesystem of the VPS hosting the MCP server, NOT the user's machine. To deliver a file to the user, use download_file_content (small files) or the HTTP GET /files/download endpoint (large files).",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        remotePath: z.string().min(1).describe("Absolute path of the file on the target VPS"),
        localPath: z.string().min(1).describe("Absolute path on the MCP server's filesystem"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          await extra.sendLog(
            `[${args.server}] Downloading ${args.remotePath} → ${args.localPath}`
          );
          await downloadFile(record, args.remotePath, args.localPath);
          return {
            content: [
              {
                type: "text",
                text: `File downloaded: ${args.server}:${args.remotePath} → ${args.localPath}`,
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
      name: "upload_file_content",
      category: "files",
      summary: "Write inline content to a remote file on a VPS (small files, ≤5 MB)",
      description:
        "Write inline content to a file on a VPS via SFTP. Use this to push small files (configs, scripts, generated code) directly from the conversation without needing a local file on the MCP server. Use 'base64' encoding for binary data. Typical safe ceiling ~5 MB; for larger files use the HTTP POST /files/upload endpoint.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        remotePath: z.string().min(1).describe("Absolute path on the target VPS"),
        content: z.string().describe("File content as a string (text or base64)"),
        encoding: z
          .enum(["utf8", "base64"])
          .default("utf8")
          .describe("How to interpret 'content' (utf8 for text, base64 for binary)"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          const buf = Buffer.from(args.content, args.encoding);
          await extra.sendLog(
            `[${args.server}] Writing ${buf.length} bytes → ${args.remotePath}`
          );
          await writeFileContent(record, args.remotePath, buf);
          return {
            content: [
              {
                type: "text",
                text: `File written: ${args.server}:${args.remotePath} (${buf.length} bytes)`,
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
      name: "download_file_content",
      category: "files",
      summary: "Read a remote file from a VPS and return content inline (small files)",
      description:
        "Read a remote file from a VPS and return its content inline. Rejects files larger than maxBytes (default 1 MB, hard cap 5 MB) to protect the conversation context. Use 'base64' encoding for binary files; for anything larger than the cap, use the HTTP GET /files/download endpoint.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        remotePath: z.string().min(1).describe("Absolute path of the file on the target VPS"),
        encoding: z
          .enum(["utf8", "base64"])
          .default("utf8")
          .describe("How to decode the bytes for return (utf8 for text, base64 for binary)"),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(INLINE_DOWNLOAD_HARD_CAP)
          .default(INLINE_DOWNLOAD_DEFAULT)
          .describe(
            `Max bytes to read (default ${INLINE_DOWNLOAD_DEFAULT}, hard cap ${INLINE_DOWNLOAD_HARD_CAP})`
          ),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          await extra.sendLog(
            `[${args.server}] Reading ${args.remotePath} (cap ${args.maxBytes} bytes)`
          );
          const { data, size } = await readFileContent(record, args.remotePath, args.maxBytes);
          return {
            content: [
              {
                type: "text",
                text:
                  `# ${args.server}:${args.remotePath} (${size} bytes, ${args.encoding})\n` +
                  data.toString(args.encoding),
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
      name: "fetch_url_to_server",
      category: "files",
      summary: "Download a public URL directly onto a VPS via curl",
      description:
        "Download a file from a public URL directly onto the VPS using curl. Useful for grabbing release artifacts, transfer.sh links, raw gists, or any HTTPS-hosted file without routing the bytes through the MCP. Uses curl -fsSL on the VPS itself.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        url: z.string().url().describe("Source URL (http/https)"),
        remotePath: z.string().min(1).describe("Absolute destination path on the VPS"),
        timeoutSec: z
          .number()
          .int()
          .positive()
          .max(3600)
          .default(300)
          .describe("curl --max-time in seconds"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          const escUrl = shellEscape(args.url);
          const escPath = shellEscape(args.remotePath);
          const command = `curl -fsSL --max-time ${args.timeoutSec} -o ${escPath} ${escUrl} && stat -c %s ${escPath}`;
          await extra.sendLog(
            `[${args.server}] Fetching ${args.url} → ${args.remotePath} (timeout ${args.timeoutSec}s)`
          );
          const result = await execCommand(record, command);
          if (result.exitCode !== 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
                },
              ],
              isError: true,
            };
          }
          const bytes = parseInt(result.stdout.trim(), 10) || 0;
          return {
            content: [
              {
                type: "text",
                text: `Fetched: ${args.url} → ${args.server}:${args.remotePath} (${bytes} bytes)`,
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
      name: "list_remote_files",
      category: "files",
      summary: "List files and directories at a remote path on a VPS",
      description: "List files and directories at a remote path on a VPS server.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        remotePath: z.string().min(1).describe("Remote directory path to list"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          await extra.sendLog(`[${args.server}] Listing ${args.remotePath}`);
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
      },
    }),
  ];
}
