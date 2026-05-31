import { z } from "zod";
import { execCommand } from "../lib/ssh-client.js";
import { getServerDocs, updateServerDocs } from "../lib/doc-manager.js";
import { resolveServer } from "./registry.js";
import { defineTool, type ToolDef } from "./registry-core.js";

const SCAN_SCRIPT = `
set -e
echo "=== OS INFO ==="
uname -a
cat /etc/os-release 2>/dev/null || true

echo ""
echo "=== HOSTNAME ==="
hostname

echo ""
echo "=== CPU & MEMORY ==="
nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
free -h 2>/dev/null || true

echo ""
echo "=== DISK USAGE ==="
df -h --output=source,size,used,avail,pcent,target 2>/dev/null || df -h

echo ""
echo "=== UPTIME ==="
uptime

echo ""
echo "=== DOCKER CONTAINERS ==="
docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "(docker not available)"

echo ""
echo "=== DOCKER IMAGES ==="
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" 2>/dev/null || echo "(docker not available)"

echo ""
echo "=== RUNNING SERVICES (systemd) ==="
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -40 || echo "(systemd not available)"

echo ""
echo "=== LISTENING PORTS ==="
ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo "(ss/netstat not available)"

echo ""
echo "=== CRON JOBS (root) ==="
crontab -l 2>/dev/null || echo "(no crontab for root)"
ls /etc/cron.d/ 2>/dev/null || true

echo ""
echo "=== ENVIRONMENT VARIABLES (non-sensitive) ==="
env | grep -vE '(KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)' | sort 2>/dev/null || true
`.trim();

export function getDocsTools(): ToolDef[] {
  return [
    defineTool({
      name: "scan_server",
      category: "docs",
      summary: "Snapshot a VPS: OS, CPU/RAM, disk, Docker, services, ports, cron",
      description:
        "SSH into a VPS server and collect a comprehensive snapshot: OS, CPU/RAM, disk, Docker containers/images, running services, open ports, cron jobs.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
      },
      handler: async (args, extra) => {
        try {
          const record = resolveServer(args.server);
          await extra.sendLog(`[${args.server}] Running scan_server snapshot...`);
          const result = await execCommand(record, SCAN_SCRIPT);
          const output = result.stdout + (result.stderr ? `\n\n[stderr]\n${result.stderr}` : "");
          return {
            content: [{ type: "text", text: output }],
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
      name: "get_server_docs",
      category: "docs",
      summary: "Read the Markdown docs file for a registered VPS",
      description: "Read the existing Markdown documentation file for a VPS server.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
      },
      handler: async ({ server: serverName }, extra) => {
        await extra.sendLog(`[${serverName}] Reading docs`);
        const docs = getServerDocs(serverName);
        if (docs === null) {
          return {
            content: [
              {
                type: "text",
                text: `No documentation found for server '${serverName}'. Use scan_server + update_server_docs to create it.`,
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: docs }],
        };
      },
    }),

    defineTool({
      name: "update_server_docs",
      category: "docs",
      summary: "Write or replace the Markdown docs file for a registered VPS",
      description: "Write or replace the Markdown documentation file for a VPS server.",
      inputSchema: {
        server: z.string().min(1).describe("Server name as registered in the vault"),
        content: z.string().min(1).describe("Full Markdown content for the server documentation"),
      },
      handler: async (args, extra) => {
        try {
          await extra.sendLog(`[${args.server}] Updating docs`);
          updateServerDocs(args.server, args.content);
          return {
            content: [
              { type: "text", text: `Documentation for '${args.server}' updated successfully.` },
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
