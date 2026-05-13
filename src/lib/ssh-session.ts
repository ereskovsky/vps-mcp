/**
 * Stateful SSH session manager.
 *
 * Each session holds:
 *   - A live ssh2 Client connection
 *   - A long-running shell channel (PTY disabled — gives us separate stdout/stderr
 *     streams and avoids terminal echo / prompt noise)
 *   - Per-command framing via a unique end-marker that the remote shell prints
 *     after the user's command finishes, so we know when output is complete and
 *     can read the exit code.
 *
 * Sessions persist process-wide (module-level Map) and are reclaimed when:
 *   - The agent calls closeSession(id)
 *   - The session has been idle for SESSION_TTL_MS
 *   - The underlying TCP connection drops
 *
 * Trade-off vs. one-shot execScript():
 *   + State persists between commands (cwd, env, shell vars, background jobs).
 *   + No SSH handshake per command (~200–500 ms saved each time).
 *   - Doesn't reduce the number of tool calls (each command is still one call).
 *   - Sessions are lost on server restart; agent re-opens as needed.
 */

import { Client } from "ssh2";
import type { ConnectConfig, ClientChannel } from "ssh2";
import { randomBytes, randomUUID } from "crypto";
import type { ServerRecord, CommandResult } from "../types.js";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per command
const MAX_SESSIONS = 10;
const STDERR_DRAIN_MS = 50; // small grace window after stdout marker for late stderr

interface Session {
  id: string;
  serverName: string;
  host: string;
  username: string;
  client: Client;
  stream: ClientChannel;
  stdoutBuf: string;
  stderrBuf: string;
  busy: boolean;
  dead: boolean;
  createdAt: number;
  lastUsed: number;
}

const SESSIONS = new Map<string, Session>();

function buildConnectConfig(server: ServerRecord): ConnectConfig {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 20_000,
    keepaliveInterval: 30_000,
  };
  if (server.authType === "key" && server.privateKey) {
    return {
      ...base,
      privateKey: Buffer.from(server.privateKey, "base64").toString("utf8"),
      passphrase: server.passphrase,
    };
  }
  return { ...base, password: server.password };
}

function evictStale(): void {
  const now = Date.now();
  for (const [id, sess] of SESSIONS) {
    if (sess.dead || now - sess.lastUsed > SESSION_TTL_MS) {
      try { sess.client.end(); } catch { /* ignore */ }
      SESSIONS.delete(id);
    }
  }
}

function newSessionId(): string {
  return randomBytes(4).toString("hex");
}

export async function openSession(server: ServerRecord): Promise<string> {
  evictStale();
  if (SESSIONS.size >= MAX_SESSIONS) {
    throw new Error(
      `Too many open sessions (max ${MAX_SESSIONS}). Close one with session_close, or wait for idle eviction.`
    );
  }

  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client
      .once("ready", () => resolve())
      .once("error", reject)
      .connect(buildConnectConfig(server));
  });

  // pty disabled → bash runs non-interactively, no prompt, no command echo,
  // stderr stays on a separate channel.
  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    client.shell(false, (err, s) => {
      if (err) reject(err);
      else resolve(s);
    });
  });

  const id = newSessionId();
  const sess: Session = {
    id,
    serverName: server.name,
    host: server.host,
    username: server.username,
    client,
    stream,
    stdoutBuf: "",
    stderrBuf: "",
    busy: false,
    dead: false,
    createdAt: Date.now(),
    lastUsed: Date.now(),
  };

  stream.on("data", (chunk: Buffer) => {
    sess.stdoutBuf += chunk.toString("utf8");
  });
  stream.stderr.on("data", (chunk: Buffer) => {
    sess.stderrBuf += chunk.toString("utf8");
  });
  const markDead = () => {
    sess.dead = true;
  };
  stream.once("close", markDead);
  stream.once("end", markDead);
  client.once("error", markDead);
  client.once("close", markDead);

  // Disable history so commands don't leak into ~/.bash_history, and silence
  // any inherited PROMPT_COMMAND that could write between commands.
  // We don't need to wait for a marker here — these are fire-and-forget.
  stream.write(
    "unset PROMPT_COMMAND; export HISTFILE=/dev/null PS1='' PS2=''; set +o history 2>/dev/null\n"
  );

  SESSIONS.set(id, sess);
  return id;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function execInSession(
  id: string,
  command: string,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
  const sess = SESSIONS.get(id);
  if (!sess) throw new Error(`Session '${id}' not found. Open one with session_open.`);
  if (sess.dead) {
    SESSIONS.delete(id);
    throw new Error(
      `Session '${id}' is closed (connection dropped or shell exited). Open a new one.`
    );
  }
  if (sess.busy) {
    throw new Error(
      `Session '${id}' is already running a command. Wait for it to finish (one command at a time per session).`
    );
  }

  sess.busy = true;
  sess.lastUsed = Date.now();

  try {
    const nonce = randomUUID().replace(/-/g, "");
    const beginMarker = `__VPS_BEGIN_${nonce}__`;
    const endMarker = `__VPS_END_${nonce}__`;
    const endRegex = new RegExp(`${endMarker}:(-?\\d+)`);

    // Frame the command with begin/end markers so we know exactly where its
    // output starts and ends, independent of any noise from previous commands.
    // `printf` is more portable than echo here.
    const framed =
      `printf '%s\\n' '${beginMarker}'\n` +
      command +
      `\n__rc=$?\n` +
      `printf '%s:%d\\n' '${endMarker}' "$__rc"\n`;

    sess.stream.write(framed);

    const start = Date.now();
    let beginSeen = false;
    while (true) {
      if (sess.dead) throw new Error("Session died mid-command");

      if (!beginSeen) {
        const beginIdx = sess.stdoutBuf.indexOf(beginMarker);
        if (beginIdx !== -1) {
          // Drop everything up to AND including the begin-marker line.
          const afterBegin = sess.stdoutBuf.slice(beginIdx + beginMarker.length);
          const lineBreak = afterBegin.indexOf("\n");
          sess.stdoutBuf =
            lineBreak === -1 ? afterBegin : afterBegin.slice(lineBreak + 1);
          beginSeen = true;
        }
      }

      if (beginSeen) {
        const endMatch = sess.stdoutBuf.match(endRegex);
        if (endMatch) {
          const endIdx = sess.stdoutBuf.indexOf(endMatch[0]);
          const stdout = sess.stdoutBuf.slice(0, endIdx).replace(/\r/g, "");
          const cleanStdout = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
          const afterEnd = sess.stdoutBuf.slice(endIdx + endMatch[0].length);
          sess.stdoutBuf = afterEnd.startsWith("\n") ? afterEnd.slice(1) : afterEnd;

          // Brief drain so late stderr writes for this command get captured.
          await delay(STDERR_DRAIN_MS);
          const stderr = sess.stderrBuf;
          sess.stderrBuf = "";

          const exitCode = parseInt(endMatch[1], 10);
          return { stdout: cleanStdout, stderr, exitCode };
        }
      }

      if (Date.now() - start > timeoutMs) {
        // Try to recover the session for future commands: send Ctrl-C.
        try { sess.stream.write("\x03"); } catch { /* ignore */ }
        throw new Error(
          `Command timed out after ${timeoutMs}ms. Sent SIGINT to the remote shell; ` +
            `if subsequent commands also misbehave, close and reopen the session.`
        );
      }

      await delay(40);
    }
  } finally {
    sess.busy = false;
    sess.lastUsed = Date.now();
  }
}

export function closeSession(id: string): boolean {
  const sess = SESSIONS.get(id);
  if (!sess) return false;
  try { sess.stream.write("exit\n"); } catch { /* ignore */ }
  try { sess.stream.end(); } catch { /* ignore */ }
  try { sess.client.end(); } catch { /* ignore */ }
  SESSIONS.delete(id);
  return true;
}

export interface SessionInfo {
  id: string;
  server: string;
  host: string;
  username: string;
  busy: boolean;
  createdAt: string;
  idleMs: number;
}

export function listSessions(): SessionInfo[] {
  evictStale();
  return Array.from(SESSIONS.values()).map((s) => ({
    id: s.id,
    server: s.serverName,
    host: s.host,
    username: s.username,
    busy: s.busy,
    createdAt: new Date(s.createdAt).toISOString(),
    idleMs: Date.now() - s.lastUsed,
  }));
}
