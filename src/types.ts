export interface ServerRecord {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "key" | "password";
  /** Base64-encoded PEM private key (when authType === "key") */
  privateKey?: string;
  /** SSH key passphrase, if any */
  passphrase?: string;
  /** Password (when authType === "password") */
  password?: string;
  /** Human-readable description of what's on this server */
  description?: string;
}

export interface VaultData {
  servers: ServerRecord[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
