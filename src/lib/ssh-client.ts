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

/** Write a Buffer to a remote path via SFTP (single shot, in-memory). */
export async function writeFileContent(
  server: ServerRecord,
  remotePath: string,
  data: Buffer
): Promise<void> {
  const client = await connect(server);
  const sftp = await getSftp(client);
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, data, (err) => {
      client.end();
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Read a remote file into a Buffer, rejecting if it exceeds maxBytes. */
export async function readFileContent(
  server: ServerRecord,
  remotePath: string,
  maxBytes: number
): Promise<{ data: Buffer; size: number }> {
  const client = await connect(server);
  const sftp = await getSftp(client);
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (statErr, stats) => {
      if (statErr) {
        client.end();
        return reject(statErr);
      }
      const size = stats.size ?? 0;
      if (size > maxBytes) {
        client.end();
        return reject(
          new Error(
            `File size ${size} bytes exceeds maxBytes ${maxBytes}. Use the HTTP /files/download endpoint for large files.`
          )
        );
      }
      sftp.readFile(remotePath, (readErr, data) => {
        client.end();
        if (readErr) reject(readErr);
        else resolve({ data, size });
      });
    });
  });
}

/** Stream a readable into a remote file via SFTP. Returns bytes written. */
export async function uploadStream(
  server: ServerRecord,
  remotePath: string,
  input: NodeJS.ReadableStream
): Promise<number> {
  const client = await connect(server);
  const sftp = await getSftp(client);
  return new Promise((resolve, reject) => {
    const writeStream = sftp.createWriteStream(remotePath);
    let bytes = 0;
    let settled = false;
    const finish = (err?: Error, value?: number) => {
      if (settled) return;
      settled = true;
      client.end();
      if (err) reject(err);
      else resolve(value ?? 0);
    };
    input.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    input.on("error", (err: Error) => finish(err));
    writeStream.on("error", (err: Error) => finish(err));
    writeStream.on("close", () => finish(undefined, bytes));
    input.pipe(writeStream);
  });
}

/** Stream a remote file into a writable. Returns the source file size from SFTP stat. */
export async function downloadStream(
  server: ServerRecord,
  remotePath: string,
  output: NodeJS.WritableStream,
  onSize?: (size: number) => void
): Promise<number> {
  const client = await connect(server);
  const sftp = await getSftp(client);
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (statErr, stats) => {
      if (statErr) {
        client.end();
        return reject(statErr);
      }
      const size = stats.size ?? 0;
      if (onSize) {
        try { onSize(size); } catch (e) { /* ignore */ }
      }
      const readStream = sftp.createReadStream(remotePath);
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        client.end();
        if (err) reject(err);
        else resolve(size);
      };
      readStream.on("error", (err: Error) => finish(err));
      readStream.on("end", () => finish());
      readStream.pipe(output, { end: true });
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
