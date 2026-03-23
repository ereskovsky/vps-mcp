/**
 * SSH client wrapper over ssh2.
 * Provides: exec, script execution, SFTP upload/download/list.
 */

import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import type { ServerRecord, CommandResult } from "../types.js";

function buildConnectConfig(server: ServerRecord): ConnectConfig {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 20_000,
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

function connect(server: ServerRecord): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on("ready", () => resolve(client))
      .on("error", reject)
      .connect(buildConnectConfig(server));
  });
}

export async function execCommand(
  server: ServerRecord,
  command: string
): Promise<CommandResult> {
  const client = await connect(server);
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        client.end();
        return reject(err);
      }

      let stdout = "";
      let stderr = "";

      stream.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      stream.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      stream.on("close", (exitCode: number | null) => {
        client.end();
        resolve({ stdout, stderr, exitCode });
      });
      stream.on("error", (e: Error) => {
        client.end();
        reject(e);
      });
    });
  });
}

/** Run a multiline bash script by writing it to a temp file and executing it. */
export async function execScript(
  server: ServerRecord,
  script: string
): Promise<CommandResult> {
  // Escape single quotes in script body, wrap in bash -c
  const escaped = script.replace(/'/g, "'\\''");
  const command = `bash -c '${escaped}'`;
  return execCommand(server, command);
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

export async function uploadFile(
  server: ServerRecord,
  localPath: string,
  remotePath: string
): Promise<void> {
  const client = await connect(server);
  const sftp = await getSftp(client);
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err) => {
      client.end();
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function downloadFile(
  server: ServerRecord,
  remotePath: string,
  localPath: string
): Promise<void> {
  const client = await connect(server);
  const sftp = await getSftp(client);
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err) => {
      client.end();
      if (err) reject(err);
      else resolve();
    });
  });
}

export interface RemoteFileEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
  permissions: string;
}

export async function listRemoteFiles(
  server: ServerRecord,
  remotePath: string
): Promise<RemoteFileEntry[]> {
  const client = await connect(server);
  const sftp = await getSftp(client);
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      client.end();
      if (err) return reject(err);

      const entries: RemoteFileEntry[] = list.map((item) => {
        const mode = item.attrs.mode ?? 0;
        let type: RemoteFileEntry["type"] = "other";
        // eslint-disable-next-line no-bitwise
        if ((mode & 0o170000) === 0o100000) type = "file";
        // eslint-disable-next-line no-bitwise
        else if ((mode & 0o170000) === 0o040000) type = "directory";
        // eslint-disable-next-line no-bitwise
        else if ((mode & 0o170000) === 0o120000) type = "symlink";

        return {
          name: item.filename,
          type,
          size: item.attrs.size ?? 0,
          modifiedAt: new Date((item.attrs.mtime ?? 0) * 1000).toISOString(),
          permissions: (mode & 0o777).toString(8).padStart(4, "0"),
        };
      });

      resolve(entries);
    });
  });
}
