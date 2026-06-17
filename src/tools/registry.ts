import { z } from "zod";
import { loadVault, saveVault } from "../lib/credential-store.js";
import type { ServerRecord } from "../types.js";
import { defineTool, type ToolDef } from "./registry-core.js";

export function getRegistryTools(): ToolDef[] {
  return [
    defineTool({
      name: "list_servers",
      category: "registry",
      summary: "List all registered VPS servers (no credentials)",
      description:
        "List all registered VPS servers (name, host, port, username, description — no keys or passwords).",
      inputSchema: {},
      handler: async () => {
        const vault = loadVault();
        const servers = vault.servers.map(
          ({ name, host, port, username, authType, description }) => ({
            name,
            host,
            port,
            username,
            authType,
            description: description ?? "",
          })
        );
        return {
          content: [{ type: "text", text: JSON.stringify(servers, null, 2) }],
        };
      },
    }),

    defineTool({
      name: "add_server",
      category: "registry",
      summary: "Register a new VPS server in the encrypted vault",
      description: "Register a new VPS server in the encrypted vault.",
      inputSchema: {
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
      handler: async (args, extra) => {
        if (args.authType === "key" && !args.privateKey) {
          return {
            content: [
              { type: "text", text: "Error: privateKey is required when authType is 'key'" },
            ],
            isError: true,
          };
        }
        if (args.authType === "password" && !args.password) {
          return {
            content: [
              { type: "text", text: "Error: password is required when authType is 'password'" },
            ],
            isError: true,
          };
        }

        await extra.sendLog(`Registering server '${args.name}' (${args.host}:${args.port})`);
        const vault = loadVault();

        if (vault.servers.some((s) => s.name === args.name)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: server '${args.name}' already exists. Use remove_server first to replace it.`,
              },
            ],
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
          content: [
            { type: "text", text: `Server '${args.name}' (${args.host}) registered successfully.` },
          ],
        };
      },
    }),

    defineTool({
      name: "update_server_description",
      category: "registry",
      summary: "Edit the description of a registered VPS (credentials untouched)",
      description:
        "Update the human-readable description of an already-registered VPS server. Only the description field is rewritten — host, port, username, and all credentials stay exactly as they are. Safer than remove_server + add_server when you just need to fix or refresh what a server is running.",
      inputSchema: {
        name: z.string().min(1).describe("Name of the server to update"),
        description: z
          .string()
          .describe("New description (pass an empty string to clear it)"),
      },
      handler: async ({ name, description }, extra) => {
        await extra.sendLog(`Updating description for server '${name}'`);
        const vault = loadVault();
        const server = vault.servers.find((s) => s.name === name);

        if (!server) {
          return {
            content: [{ type: "text", text: `Error: server '${name}' not found.` }],
            isError: true,
          };
        }

        const previous = server.description ?? "";
        server.description = description;
        saveVault(vault);

        return {
          content: [
            {
              type: "text",
              text:
                `Description for '${name}' updated.\n\n` +
                `Before: ${previous || "(empty)"}\n` +
                `After:  ${description || "(empty)"}`,
            },
          ],
        };
      },
    }),

    defineTool({
      name: "remove_server",
      category: "registry",
      summary: "Remove a VPS server from the encrypted vault",
      description: "Remove a VPS server from the encrypted vault.",
      inputSchema: {
        name: z.string().min(1).describe("Name of the server to remove"),
      },
      handler: async ({ name }, extra) => {
        await extra.sendLog(`Removing server '${name}'`);
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
      },
    }),
  ];
}

/** Internal helper: resolve a server record by name, throws on missing. */
export function resolveServer(name: string): ServerRecord {
  const vault = loadVault();
  const server = vault.servers.find((s) => s.name === name);
  if (!server) throw new Error(`Server '${name}' not found in vault.`);
  return server;
}
