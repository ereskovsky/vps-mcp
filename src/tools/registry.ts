import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadVault, saveVault } from "../lib/credential-store.js";
import type { ServerRecord } from "../types.js";

export function registerRegistryTools(server: McpServer): void {
  // ── list_servers ──────────────────────────────────────────────────────────
  server.tool(
    "list_servers",
    "List all registered VPS servers (name, host, port, username, description — no keys or passwords)",
    {},
    async () => {
      const vault = loadVault();
      const servers = vault.servers.map(({ name, host, port, username, authType, description }) => ({
        name,
        host,
        port,
        username,
        authType,
        description: description ?? "",
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(servers, null, 2),
          },
        ],
      };
    }
  );

  // ── add_server ────────────────────────────────────────────────────────────
  server.tool(
    "add_server",
    "Register a new VPS server in the encrypted vault",
    {
      name: z.string().min(1).describe("Unique server name (identifier)"),
      host: z.string().min(1).describe("IP address or hostname"),
      port: z.number().int().min(1).max(65535).default(22).describe("SSH port"),
      username: z.string().min(1).describe("SSH username"),
      authType: z.enum(["key", "password"]).describe("Authentication type"),
      privateKey: z
        .string()
        .optional()
        .describe("Base64-encoded PEM private key (required when authType=key)"),
      passphrase: z
        .string()
        .optional()
        .describe("Passphrase for the private key (if encrypted)"),
      password: z
        .string()
        .optional()
        .describe("SSH password (required when authType=password)"),
      description: z
        .string()
        .optional()
        .describe("Human-readable description of what's on this server"),
    },
    async (args, extra) => {
      if (args.authType === "key" && !args.privateKey) {
        return {
          content: [{ type: "text", text: "Error: privateKey is required when authType is 'key'" }],
          isError: true,
        };
      }
      if (args.authType === "password" && !args.password) {
        return {
          content: [{ type: "text", text: "Error: password is required when authType is 'password'" }],
          isError: true,
        };
      }

      try { await server.sendLoggingMessage({ level: "info", data: `Registering server '${args.name}' (${args.host}:${args.port})` }, extra.sessionId); } catch {}
      const vault = loadVault();

      if (vault.servers.some((s) => s.name === args.name)) {
        return {
          content: [{ type: "text", text: `Error: server '${args.name}' already exists. Use remove_server first to replace it.` }],
          isError: true,
        };
      }

      const record: ServerRecord = {
        name: args.name,
        host: args.host,
        port: args.port,
        username: args.username,
        authType: args.authType,
        privateKey: args.privateKey,
        passphrase: args.passphrase,
        password: args.password,
        description: args.description,
      };

      vault.servers.push(record);
      saveVault(vault);

      return {
        content: [{ type: "text", text: `Server '${args.name}' (${args.host}) registered successfully.` }],
      };
    }
  );

  // ── remove_server ─────────────────────────────────────────────────────────
  server.tool(
    "remove_server",
    "Remove a VPS server from the encrypted vault",
    {
      name: z.string().min(1).describe("Name of the server to remove"),
    },
    async ({ name }, extra) => {
      try { await server.sendLoggingMessage({ level: "info", data: `Removing server '${name}'` }, extra.sessionId); } catch {}
      const vault = loadVault();
      const before = vault.servers.length;
      vault.servers = vault.servers.filter((s) => s.name !== name);

      if (vault.servers.length === before) {
        return {
          content: [{ type: "text", text: `Error: server '${name}' not found.` }],
          isError: true,
        };
      }

      saveVault(vault);
      return {
        content: [{ type: "text", text: `Server '${name}' removed successfully.` }],
      };
    }
  );
}

/** Internal helper: resolve a server record by name, throws on missing. */
export function resolveServer(name: string): ServerRecord {
  const vault = loadVault();
  const server = vault.servers.find((s) => s.name === name);
  if (!server) throw new Error(`Server '${name}' not found in vault.`);
  return server;
}
