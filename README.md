# vps-mcp

An MCP (Model Context Protocol) server for managing VPS servers via SSH. Connect it to Claude Code, Claude Desktop, or Claude.ai to execute commands, transfer files, manage Docker containers, and maintain per-server documentation — all from within Claude.

[Русская версия](README.ru.md)

## Features

- **SSH execution** — run commands and shell scripts on remote servers
- **File transfer** — SFTP plus three remote-friendly channels: inline content tools, streaming HTTP endpoints, and URL fetch-to-server
- **Docker management** — `docker ps`, `docker compose`, `docker exec`, deploy apps
- **Server docs** — scan a server and generate/update Markdown documentation per server
- **Encrypted vault** — server credentials stored with AES-256-GCM + PBKDF2

## How it works

```
Claude Code / Claude Desktop / Claude.ai
              │
              │  MCP protocol
              ▼
        vps-mcp (this server)
              │
              │  SSH / SFTP
              ▼
       Your VPS servers
```

vps-mcp stores SSH keys and passwords in an **encrypted vault** (AES-256-GCM). On every tool call it opens an SSH connection to the target server, executes the action, and returns the result.

Two transport modes are supported:
- **stdio** — for local use (Claude Code, Claude Desktop on the same machine)
- **HTTP (Streamable HTTP)** — for remote access (other devices, Claude.ai web)

## Installation

**Requirements:** Node.js 20+

```bash
git clone https://github.com/ereskovsky/vps-mcp
cd vps-mcp
npm install
npm run build
```

Create `.env` from the template:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Master password for the encrypted vault. Pick any strong passphrase.
VAULT_PASSWORD=your-strong-passphrase

# Bearer token for HTTP mode (generate with: openssl rand -hex 32)
API_KEY=your-random-api-key

# HTTP port (default: 3001)
# PORT=3001

# For HTTP mode with OAuth (required for Claude.ai web)
BASE_URL=https://vps-mcp.yourdomain.com  # no port — required for OAuth metadata to work
CLIENT_ID=vps-mcp                         # any string, needed when adding the integration in Claude.ai
CLIENT_SECRET=                            # defaults to API_KEY if not set
```

## Local usage (stdio)

This mode works **without any server deployment** — vps-mcp runs on your machine and connects to VPS servers over SSH.

### Claude Code

```bash
claude mcp add vps-mcp -s user -e VAULT_PASSWORD="your-password" -- node "/path/to/vps-mcp/dist/index.js" --stdio
```

### Claude Desktop

Add to `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on Mac, `%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "vps-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/vps-mcp/dist/index.js", "--stdio"],
      "env": {
        "VAULT_PASSWORD": "your-password"
      }
    }
  }
}
```

## Deploy to a VPS (HTTP mode)

Required for remote access from other devices or Claude.ai web.

### 1. Prepare

Clone the repo on your VPS. Edit `Caddyfile` and replace the domain:

```
vps-mcp.yourdomain.com {
    reverse_proxy vps-mcp:3001
}
```

Make sure your domain's DNS A record points to the VPS IP.

### 2. Start

```bash
cp .env.example .env
# Fill in VAULT_PASSWORD and API_KEY

docker compose up -d
```

Caddy will automatically obtain a TLS certificate via Let's Encrypt.

### 3. Connect clients

Claude Code / Claude Desktop (remote):

```bash
claude mcp add vps-mcp -s user --transport http "https://vps-mcp.yourdomain.com/mcp" \
  --header "Authorization: Bearer your-api-key"
```

Or manually in config:

```json
{
  "mcpServers": {
    "vps-mcp": {
      "url": "https://vps-mcp.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

## Connecting to Claude.ai (web, OAuth)

Claude.ai uses OAuth 2.0 (`authorization_code` + PKCE) to connect to remote MCP servers. vps-mcp implements the full OAuth flow.

### Requirements

- Server deployed and reachable over HTTPS
- `BASE_URL` in `.env` must be the public domain **without a non-standard port** (e.g. `https://vps-mcp.yourdomain.com`, not `https://...:4443`) — otherwise Claude.ai cannot reach the `token_endpoint` from the OAuth metadata

### Steps

1. Open **Claude.ai → Settings → Integrations → Add integration**
2. Enter URL: `https://vps-mcp.yourdomain.com/mcp`
3. Enter **Client ID** (value of `CLIENT_ID` from `.env`)
4. Enter **Client Secret** (value of `CLIENT_SECRET` from `.env`, defaults to `API_KEY`)
5. Claude.ai will open an authorization page — confirm access

### OAuth endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /.well-known/oauth-authorization-server` | OAuth metadata (discovery) |
| `GET /oauth/authorize` | Authorization page (browser redirect) |
| `POST /oauth/token` | Exchange code for token |

## Adding a server to the vault

### Via SSH key (recommended)

Encode your private key in base64 first:

```bash
# Linux / Mac
base64 -w 0 ~/.ssh/id_ed25519

# Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.ssh\id_ed25519"))
```

Then call the `add_server` tool:

```
name: prod-1
host: 1.2.3.4
port: 22
username: root
authType: key
privateKey: <base64 string from above>
passphrase: <key passphrase, if any>
description: Main production server
```

### Via password

```
name: staging
host: 5.6.7.8
port: 22
username: ubuntu
authType: password
password: your-ssh-password
description: Staging environment
```

## Tool discovery model (progressive discovery)

When a client connects, `tools/list` returns **only 4 meta-tools**, not the 18 real ones. The model uses them to find and call the actual tools on demand, which keeps the LLM's "cold" context cost down to roughly **1K tokens instead of 5–10K**.

| Meta-tool | What it does |
|-----------|--------------|
| `list_tool_categories` | Lists the 5 categories (registry, ssh, files, deploy, docs) with tool counts and descriptions. |
| `search_tools` | Searches tools by `query` (substring against name/summary/description) and/or `category`. Returns lightweight `{name, category, summary}` — not full schemas. |
| `get_tool_schemas` | Returns full descriptions and JSON Schema input definitions for 1–10 tools by name. |
| `invoke_tool` | Executes a real tool: `{name, arguments}`. Arguments are strictly Zod-validated against the tool's schema. |

Typical LLM workflow:

```
search_tools({query: "docker"})           → ["docker_ps", "docker_compose", "docker_exec", ...]
get_tool_schemas({names: ["docker_ps"]})  → full schema for docker_ps
invoke_tool({name: "docker_ps", arguments: {server: "prod"}}) → result
```

The real tools below are documented for human reference — the model discovers them through `search_tools` / `get_tool_schemas`.

## Tools

### Registry — server management

#### `list_servers`
Returns all registered servers. Passwords and keys are **never exposed**.

#### `add_server`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Unique identifier (letters, digits, `-_`) |
| `host` | string | yes | IP address or hostname |
| `port` | number | no | SSH port (default: 22) |
| `username` | string | yes | SSH user |
| `authType` | `key` / `password` | yes | Authentication type |
| `privateKey` | string | if `key` | Base64-encoded PEM private key |
| `passphrase` | string | no | Key passphrase |
| `password` | string | if `password` | SSH password |
| `description` | string | no | Server description |

#### `remove_server`

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Server name to remove |

---

### SSH — command execution

#### `execute_command`
Runs a single command on the server.

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name from vault |
| `command` | string | Shell command |

```
→ execute_command(server="prod-1", command="df -h")
← { stdout: "...", stderr: "", exitCode: 0 }
```

#### `execute_script`
Runs a multi-line bash script.

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `script` | string | Bash script (multi-line) |

---

### Files — SFTP transfer

> **Important — local vs. remote mode**
>
> `upload_file` / `download_file` use `localPath` on the **MCP server's own filesystem**. In stdio mode that is your machine (works as expected). In HTTP/remote mode (Claude.ai web) the MCP server runs on a VPS — `localPath` then refers to that VPS, **not your machine**. For transfers from your machine in remote mode, use the inline content tools below or the HTTP file endpoints.

#### `upload_file`

Upload a file from the MCP server's local filesystem to a target VPS via SFTP.

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `localPath` | string | Absolute path on the MCP server's filesystem |
| `remotePath` | string | Absolute destination path on the target VPS |

#### `download_file`

Download a file from a target VPS to the MCP server's local filesystem via SFTP.

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `remotePath` | string | Path on the target VPS |
| `localPath` | string | Path on the MCP server's filesystem |

#### `upload_file_content`

Write inline content to a remote file — no MCP-server-side file needed. Use this in remote mode for configs, scripts, and small code files the model generates in conversation. Soft ceiling ≈ 5 MB; for larger files use the `POST /files/upload` HTTP endpoint.

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `remotePath` | string | Absolute destination path on the target VPS |
| `content` | string | File content (text or base64) |
| `encoding` | `utf8` / `base64` | Default `utf8`. Use `base64` for binary data |

#### `download_file_content`

Read a remote file and return its content inline. Rejects files larger than `maxBytes` to protect the conversation context.

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `remotePath` | string | Path on the target VPS |
| `encoding` | `utf8` / `base64` | Default `utf8`. Use `base64` for binary data |
| `maxBytes` | number | Max bytes to read. Default 1 MB, hard cap 5 MB |

#### `fetch_url_to_server`

Download a file from a public URL **directly onto the VPS** via `curl`. Bytes don't pass through the MCP host or Claude — handy for release artifacts, transfer.sh links, raw gists, S3 presigned URLs.

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `url` | string | http/https source URL |
| `remotePath` | string | Absolute destination on the VPS |
| `timeoutSec` | number | `curl --max-time` (default 300, max 3600) |

#### `list_remote_files`

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `remotePath` | string | Directory path on server |

```
← [{ name, type, size, modifiedAt, permissions }]
```

---

### HTTP file endpoints (large files, streamed)

The HTTP server exposes two endpoints alongside `/mcp` for transferring files of any size. They stream directly between the user and the target VPS via SFTP, so they bypass the inline-content size limits of MCP tool calls. Use the same Bearer token as `/mcp`.

#### `POST /files/upload?server=<name>&path=<absolute-remote-path>`

Body: raw bytes (`Content-Type: application/octet-stream`). Response: `{ ok: true, server, path, bytes }`.

```bash
curl -H "Authorization: Bearer $API_KEY" \
  --data-binary "@./local-archive.tar.gz" \
  "https://vps-mcp.yourdomain.com/files/upload?server=prod-1&path=/tmp/local-archive.tar.gz"
```

PowerShell:

```powershell
curl -H "Authorization: Bearer $env:API_KEY" `
  --data-binary "@./local-archive.tar.gz" `
  "https://vps-mcp.yourdomain.com/files/upload?server=prod-1&path=/tmp/local-archive.tar.gz"
```

The destination directory must already exist (the endpoint does not auto-`mkdir`). After upload, ask Claude to unpack/move/install via `execute_command`.

#### `GET /files/download?server=<name>&path=<absolute-remote-path>`

Streams the remote file back as the response body with `Content-Disposition: attachment`.

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://vps-mcp.yourdomain.com/files/download?server=prod-1&path=/var/log/app.log" \
  -o app.log
```

---

### Docker & Deploy

#### `docker_ps`

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `all` | boolean | Include stopped containers (default: true) |

#### `docker_compose`

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `path` | string | Absolute path to directory with `docker-compose.yml` |
| `action` | enum | `up` / `down` / `restart` / `pull` / `logs` / `ps` / `build` |
| `service` | string | (optional) Specific service name |
| `flags` | string | (optional) Extra flags |

#### `docker_exec`

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `container` | string | Container name or ID |
| `command` | string | Command to execute |

#### `deploy_app`
Deploys an app: git pull → build → restart.

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `path` | string | App directory path |
| `branch` | string | Git branch (default: `main`) |
| `buildCommand` | string | (optional) Build command |
| `restartCommand` | string | (optional) Restart command |

---

### Docs — server documentation

#### `scan_server`
Scans the server and returns a full snapshot:
- OS and kernel version
- CPU and RAM
- Disk usage
- Uptime
- Running Docker containers and images
- Active systemd services
- Open ports (ss / netstat)
- Cron jobs

#### `get_server_docs`
Reads stored Markdown documentation from `data/docs/{server}.md`.

#### `update_server_docs`
Writes or replaces the Markdown documentation for a server.

| Parameter | Type | Description |
|-----------|------|-------------|
| `server` | string | Server name |
| `content` | string | Full Markdown content |

---

## Common workflows

### Onboarding a new server

```
1. add_server        — register the server
2. execute_command   — verify connection: "uptime"
3. scan_server       — collect a state snapshot
4. update_server_docs — save documentation
```

### Deploying an app

```
1. deploy_app        — git pull + build + restart
2. docker_ps         — check container status
3. docker_compose    — check logs: action="logs"
```

### Debugging a server issue

```
1. execute_command   — "journalctl -u nginx --since '10 minutes ago'"
2. docker_compose    — action="logs", flags="--tail=200"
3. execute_command   — "df -h && free -h"
```

## Security

- **Vault** (`data/servers.enc.json`) is encrypted with AES-256-GCM; the key is derived via PBKDF2 (100,000 iterations) from `VAULT_PASSWORD`
- SSH keys and passwords are **never stored or transmitted in plaintext** — only via the encrypted vault
- The vault file and `data/` directory are in `.gitignore` — never committed to the repo
- HTTP mode is protected by a Bearer token (`API_KEY`) on every request
- When connecting via Claude.ai, OAuth 2.0 (`authorization_code` + PKCE) is used — no direct API key exposure to the client
- HTTPS is handled by Caddy (automatic TLS via Let's Encrypt)
- `list_servers` and logs never expose keys or passwords

> **RAM note:** If your VPS has limited RAM (< 512 MB), avoid running `npm install` on the server — it may trigger the OOM killer. Install dependencies locally and upload `node_modules/`.

## Project structure

```
src/
  index.ts               # Entry point — picks stdio vs HTTP mode
  server.ts              # createServer() — registers ONLY the 4 meta-tools
  types.ts               # Shared types: ServerRecord, VaultData, CommandResult
  lib/
    credential-store.ts  # Encrypted vault (AES-256-GCM + PBKDF2)
    ssh-client.ts        # SSH wrapper: execCommand, execScript, SFTP upload/download/list
    doc-manager.ts       # Per-server Markdown docs (data/docs/{name}.md)
  tools/
    registry-core.ts     # Central registry, search, Zod→JSON Schema util, ToolDef type
    meta.ts              # The 4 meta-tools (list_tool_categories, search_tools, get_tool_schemas, invoke_tool)
    registry.ts          # getRegistryTools() — list_servers, add_server, remove_server
    ssh.ts               # getSshTools()      — execute_command, execute_script
    files.ts             # getFileTools()     — upload_file, download_file, upload_file_content, download_file_content, fetch_url_to_server, list_remote_files
    deploy.ts            # getDeployTools()   — docker_ps, docker_compose, docker_exec, deploy_app
    docs.ts              # getDocsTools()     — scan_server, get_server_docs, update_server_docs
```

## License

MIT
