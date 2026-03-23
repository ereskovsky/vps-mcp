/**
 * Entry point for vps-mcp.
 *
 * Modes:
 *   --stdio   → StdioServerTransport  (Claude Code / Claude Desktop local)
 *   (default) → StreamableHTTPServerTransport via Express  (remote / Dispatch)
 *
 * Required env vars:
 *   VAULT_PASSWORD   Master password for the encrypted credential vault (all modes)
 *   API_KEY          Bearer token for HTTP mode authentication
 *   PORT             HTTP port (default: 3001)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "./server.js";

const isStdio = process.argv.includes("--stdio");

async function startStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio mode: keep process alive
}

async function startHttp(): Promise<void> {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.error("ERROR: API_KEY env var must be set for HTTP mode.");
    process.exit(1);
  }

  const port = parseInt(process.env.PORT ?? "3001", 10);
  const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // CORS — required for browser-initiated OAuth token requests
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") { res.status(200).send("ok"); return; }
    next();
  });

  // Bearer token authentication middleware (header or ?key= query param)
  function authenticate(req: Request, res: Response, next: NextFunction): void {
    const auth = req.headers.authorization ?? "";
    const queryKey = (req.query.key as string) ?? "";
    if (auth !== `Bearer ${apiKey}` && queryKey !== apiKey) {
      res.set("WWW-Authenticate", `Bearer realm="vps-mcp", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  // ── OAuth 2.0 (required by Claude.ai remote connectors) ──────────────────

  // OAuth server metadata discovery
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "client_credentials"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    });
  });


  const CLIENT_ID = process.env.CLIENT_ID ?? "vps-mcp";
  const CLIENT_SECRET = process.env.CLIENT_SECRET ?? apiKey;

  // Authorization endpoint — auto-redirect, embeds PKCE challenge in code
  app.get("/oauth/authorize", (req: Request, res: Response) => {
    const { redirect_uri, state, client_id, code_challenge, code_challenge_method } = req.query as Record<string, string>;
    if (client_id !== CLIENT_ID) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }
    // Encode {apiKey, code_challenge} stateless so we can validate PKCE at token exchange
    const payload = Buffer.from(JSON.stringify({ k: apiKey, cc: code_challenge ?? "", cm: code_challenge_method ?? "" })).toString("base64url");
    const url = new URL(redirect_uri);
    url.searchParams.set("code", payload);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  // Token endpoint — validate PKCE and optional client_secret
  app.post("/oauth/token", async (req: Request, res: Response) => {
    const { code, grant_type, client_id, client_secret, code_verifier } = req.body as Record<string, string>;
    if (client_id !== CLIENT_ID) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    // client_credentials — Claude.ai uses this when Client ID + Secret are provided in connector settings
    if (grant_type === "client_credentials") {
      if (client_secret !== CLIENT_SECRET) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      res.json({ access_token: apiKey, token_type: "bearer", expires_in: 86400 });
      return;
    }

    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    // Validate client_secret if provided (public clients may omit it)
    if (client_secret && client_secret !== CLIENT_SECRET) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }
    let payload: { k: string; cc: string; cm: string };
    try { payload = JSON.parse(Buffer.from(code, "base64url").toString()); } catch { payload = { k: "", cc: "", cm: "" }; }
    if (payload.k !== apiKey) {
      res.status(401).json({ error: "invalid_grant" });
      return;
    }
    // Validate PKCE if code_challenge was set
    if (payload.cc) {
      if (!code_verifier) {
        res.status(401).json({ error: "invalid_grant", error_description: "code_verifier required" });
        return;
      }
      const { createHash } = await import("crypto");
      const digest = createHash("sha256").update(code_verifier).digest("base64url");
      if (digest !== payload.cc) {
        res.status(401).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }
    res.json({ access_token: apiKey, token_type: "bearer", expires_in: 86400 });
  });

  // ─────────────────────────────────────────────────────────────────────────

  // GET /mcp — SSE stream for server-initiated messages (required by some clients)
  app.get("/mcp", authenticate, async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      req.headers.accept = "text/event-stream";
      await server.connect(transport);
      await transport.handleRequest(req, res, undefined);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  });

  // Each request gets its own stateless transport instance (no sessions needed
  // for typical tool-calling workflows).
  app.post("/mcp", authenticate, async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      // Ensure Accept header satisfies MCP SDK requirements
      req.headers.accept = "application/json, text/event-stream";
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "vps-mcp", version: "1.0.0" });
  });

  app.listen(port, () => {
    console.log(`vps-mcp HTTP server running on port ${port}`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  });
}

if (!process.env.VAULT_PASSWORD) {
  console.error("ERROR: VAULT_PASSWORD env var must be set.");
  process.exit(1);
}

if (isStdio) {
  startStdio().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
} else {
  startHttp().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
