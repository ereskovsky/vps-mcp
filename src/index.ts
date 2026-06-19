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
import { resolveServer } from "./tools/registry.js";
import { uploadStream, downloadStream } from "./lib/ssh-client.js";
import { verifyTransferToken, type TransferOp } from "./lib/transfer-token.js";
import { signAccessToken, verifyAccessToken, signAuthCode, verifyAuthCode } from "./lib/access-token.js";
import { timingSafeEqual } from "crypto";
import path from "path";

const isStdio = process.argv.includes("--stdio");

async function startStdio(): Promise<void> {
  // stdio clients (Claude Code, Claude Desktop) have plenty of context — skip
  // the meta-gateway and expose every tool directly to avoid the per-call
  // `invoke_tool` wrapper and the search_tools/get_tool_schemas discovery dance.
  const server = createServer("direct");
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

  // CORS — required for browser-initiated OAuth token requests
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") { res.status(200).send("ok"); return; }
    next();
  });

  // Constant-time string compare (don't leak the key length-by-length via early-exit).
  function safeEqualStr(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  // Bearer authentication — HEADER ONLY (no ?key= query, which leaks via access
  // logs, Referer headers, and browser history). Accepts the master API_KEY
  // (admin / break-glass) OR a signed, short-lived, audience-bound access token
  // minted by /oauth/token (the connector path). The master key is never handed
  // out as an OAuth token anymore.
  function authenticate(req: Request, res: Response, next: NextFunction): void {
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (bearer && (safeEqualStr(bearer, apiKey!) || verifyAccessToken(bearer, { audience: baseUrl }))) {
      next();
      return;
    }
    res.set("WWW-Authenticate", `Bearer realm="vps-mcp", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    res.status(401).json({ error: "Unauthorized" });
  }

  // Auth for the streaming file endpoints: accept EITHER full access (master
  // API_KEY or a signed access token, HEADER ONLY) OR a short-lived scoped
  // transfer token bound to this exact server + path + operation. Scoped tokens
  // let `prepare_file_transfer` hand the model a self-contained command (they may
  // ride in ?token= for a curl one-liner); the master key never travels in a query.
  function transferAuth(op: TransferOp) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const auth = req.headers.authorization ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";

      // Full access — master key or signed access token (header only).
      if (bearer && (safeEqualStr(bearer, apiKey!) || verifyAccessToken(bearer, { audience: baseUrl }))) {
        next();
        return;
      }

      // Scoped token — from the Authorization header or ?token=.
      const token = bearer || ((req.query.token as string) ?? "");
      const serverName = (req.query.server as string) ?? "";
      const remotePath = (req.query.path as string) ?? "";
      if (
        token &&
        serverName &&
        remotePath &&
        verifyTransferToken(token, { server: serverName, path: remotePath, op })
      ) {
        next();
        return;
      }

      res.set(
        "WWW-Authenticate",
        `Bearer realm="vps-mcp", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
      );
      res.status(401).json({ error: "Unauthorized" });
    };
  }

  // ── File transfer endpoints ───────────────────────────────────────────────
  // IMPORTANT: registered BEFORE express.json() so the raw request body stays
  // available as a stream for SFTP upload.

  // POST /files/upload?server=<name>&path=<absolute-remote-path>
  //   Body: raw bytes. Streams directly to SFTP without buffering in RAM.
  app.post("/files/upload", transferAuth("upload"), async (req: Request, res: Response) => {
    const serverName = (req.query.server as string) ?? "";
    const remotePath = (req.query.path as string) ?? "";
    if (!serverName || !remotePath) {
      res.status(400).json({ error: "Missing required query params: server, path" });
      return;
    }
    try {
      const record = resolveServer(serverName);
      const bytes = await uploadStream(record, remotePath, req);
      res.json({ ok: true, server: serverName, path: remotePath, bytes });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message });
      } else {
        res.end();
      }
    }
  });

  // GET /files/download?server=<name>&path=<absolute-remote-path>
  //   Streams the remote file to the response body.
  app.get("/files/download", transferAuth("download"), async (req: Request, res: Response) => {
    const serverName = (req.query.server as string) ?? "";
    const remotePath = (req.query.path as string) ?? "";
    if (!serverName || !remotePath) {
      res.status(400).json({ error: "Missing required query params: server, path" });
      return;
    }
    try {
      const record = resolveServer(serverName);
      const filename = path.posix.basename(remotePath) || "download";
      // Strip CR/LF and quotes from filename header (defense-in-depth)
      const safeFilename = filename.replace(/[\r\n"]/g, "_");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
      await downloadStream(record, remotePath, res, (size) => {
        res.setHeader("Content-Length", String(size));
      });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message });
      } else {
        res.end();
      }
    }
  });
  // ──────────────────────────────────────────────────────────────────────────

  // Body parsers — applied only to routes registered after this point.
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

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
  const ACCESS_TOKEN_TTL = parseInt(process.env.ACCESS_TOKEN_TTL_SECONDS ?? "86400", 10);

  // Authorization endpoint — auto-redirect with a SIGNED, short-lived code that
  // carries only the PKCE challenge (no secret), so it is safe in the redirect URL.
  app.get("/oauth/authorize", (req: Request, res: Response) => {
    const { redirect_uri, state, client_id, code_challenge, code_challenge_method } = req.query as Record<string, string>;
    if (client_id !== CLIENT_ID) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }
    const code = signAuthCode({
      codeChallenge: code_challenge ?? "",
      codeChallengeMethod: code_challenge_method ?? "",
      expiresInSec: 300,
    });
    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
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

    // Mint a signed, short-lived, audience-bound token — NOT the master API_KEY.
    const issue = () => {
      const { token, expiresIn } = signAccessToken({
        audience: baseUrl,
        issuer: baseUrl,
        clientId: CLIENT_ID,
        expiresInSec: ACCESS_TOKEN_TTL,
      });
      res.json({ access_token: token, token_type: "bearer", expires_in: expiresIn });
    };

    // client_credentials — Claude.ai uses this when Client ID + Secret are provided in connector settings
    if (grant_type === "client_credentials") {
      if (client_secret !== CLIENT_SECRET) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      issue();
      return;
    }

    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    // Validate client_secret if provided (public PKCE clients may omit it)
    if (client_secret && client_secret !== CLIENT_SECRET) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }
    // Verify the signed authorization code (proves we issued it) + expiry.
    const codeClaims = verifyAuthCode(code ?? "");
    if (!codeClaims) {
      res.status(401).json({ error: "invalid_grant" });
      return;
    }
    // Validate PKCE if a code_challenge was set at authorize time.
    if (codeClaims.cc) {
      if (!code_verifier) {
        res.status(401).json({ error: "invalid_grant", error_description: "code_verifier required" });
        return;
      }
      const { createHash } = await import("crypto");
      const digest = createHash("sha256").update(code_verifier).digest("base64url");
      if (digest !== codeClaims.cc) {
        res.status(401).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }
    issue();
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
