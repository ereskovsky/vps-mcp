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
import { signTransferToken } from "../lib/transfer-token.js";
import { defineTool, type ToolDef } from "./registry-core.js";

const INLINE_DOWNLOAD_HARD_CAP = 5 * 1024 * 1024; // 5 MB
const INLINE_DOWNLOAD_DEFAULT = 1 * 1024 * 1024; // 1 MB

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function getFileTools(): ToolDef[] {
  return [
    defineTool({
      name: "prepare_file_transfer",
      category: "files",
      summary:
        "Get a ready-to-run curl command (no base64) to stream a local file to/from a VPS at full speed",
      description:
        "PREFERRED way to move a real file between the user's LOCAL machine (where Claude Code runs) and a VPS. Returns a ready-to-run curl command (PowerShell `curl.exe` + bash variants) plus a short-lived scoped token. The model runs the command in its LOCAL shell: bytes stream local↔server over HTTPS and NEVER pass through the conversation or base64 — so there is no size cap and no refusal. Use this instead of upload_file_content for anything that is not tiny inline text: binaries, archives, deploy artifacts. direction='upload' pushes a local file to the VPS; 'download' pulls a remote file to local. After running it, confirm the command exits 0 / prints HTTP 200, then verify integrity with the returned check.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        remotePath: z
          .string()
          .min(1)
          .describe(
            "Absolute path of the file ON THE VPS (destination for upload, source for download)"
          ),
        direction: z
          .enum(["upload", "download"])
          .default("upload")
          .describe("'upload' = local→VPS, 'download' = VPS→local"),
        expiresInSec: z
          .number()
          .int()
          .positive()
          .max(3600)
          .default(900)
          .describe("Scoped-token lifetime in seconds (default 900 = 15 min)"),
      },
      handler: async (args, extra) => {
        try {
          resolveServer(args.server); // validate the server exists (throws otherwise)
          const op = args.direction;
          const baseUrl =
            process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? "3001"}`;
          const { token, expiresAt } = signTransferToken({
            server: args.server,
            path: args.remotePath,
            op,
            expiresInSec: args.expiresInSec,
          });
          const qs =
            `server=${encodeURIComponent(args.server)}` +
            `&path=${encodeURIComponent(args.remotePath)}`;
          const url = `${baseUrl}/files/${op}?${qs}`;
          const authHeader = `Authorization: Bearer ${token}`;
          const placeholder = "<LOCAL_FILE>"; // model substitutes the absolute local path

          let powershell: string;
          let bash: string;
          if (op === "upload") {
            powershell = `curl.exe --fail-with-body -sS -w "\\nHTTP %{http_code}, %{size_upload} bytes" -H "${authHeader}" --data-binary "@${placeholder}" "${url}"`;
            bash = `curl --fail-with-body -sS -w '\\nHTTP %{http_code}, %{size_upload} bytes' -H '${authHeader}' --data-binary "@${placeholder}" "${url}"`;
          } else {
            powershell = `curl.exe --fail-with-body -sS -w "\\nHTTP %{http_code}, %{size_download} bytes" -H "${authHeader}" -o "${placeholder}" "${url}"`;
            bash = `curl --fail-with-body -sS -w '\\nHTTP %{http_code}, %{size_download} bytes' -H '${authHeader}' -o "${placeholder}" "${url}"`;
          }

          const verify =
            op === "upload"
              ? `After upload, verify integrity: run execute_script on '${args.server}' with \`sha256sum ${JSON.stringify(
                  args.remotePath
                )}\` and compare to the local file (PowerShell: \`Get-FileHash -Algorithm SHA256 <LOCAL_FILE>\`). The two hashes MUST match.`
              : `After download, verify integrity: compare the local file's SHA-256 to \`sha256sum ${JSON.stringify(
                  args.remotePath
                )}\` run via execute_script on '${args.server}'. The two hashes MUST match.`;

          await extra.sendLog(
            `[${args.server}] Minted ${op} token for ${args.remotePath} (TTL ${args.expiresInSec}s)`
          );

          const result = {
            direction: op,
            server: args.server,
            remotePath: args.remotePath,
            url,
            expires_at: new Date(expiresAt * 1000).toISOString(),
            expires_in_sec: args.expiresInSec,
            instructions:
              `Run EXACTLY one of the commands below in your LOCAL shell (PowerShell → use 'powershell' with curl.exe, NOT the 'curl' alias; Bash tool → use 'bash'). Replace ONLY ${placeholder} with the absolute local path — keep the token, header, and URL verbatim. Confirm the command exits 0 and prints "HTTP 200". On any HTTP error, FIX it — never fall back to base64/upload_file_content.`,
            powershell,
            bash,
            verify,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
        "Write SMALL inline TEXT you generate (configs, scripts, snippets) to a file on a VPS via SFTP. Do NOT use this to move an existing LOCAL file or any binary — base64-ing real files routes the bytes through the conversation (slow, hard ~5 MB cap, frequently refused). For ANY real file, binary, archive, or deploy artifact, use `prepare_file_transfer` instead. Reserve 'base64' here for tiny binary blobs you must inline.",
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
