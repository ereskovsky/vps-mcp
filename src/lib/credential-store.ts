/**
 * Encrypted credential vault using AES-256-GCM + PBKDF2.
 * Master password comes from VAULT_PASSWORD env var.
 * Vault file: data/servers.enc.json
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { VaultData } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT_PATH = join(__dirname, "../../data/servers.enc.json");
const DATA_DIR = join(__dirname, "../../data");

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 16;
const TAG_LEN = 16;
const SALT_LEN = 32;
const PBKDF2_ITER = 100_000;

function getMasterPassword(): string {
  const pwd = process.env.VAULT_PASSWORD;
  if (!pwd) throw new Error("VAULT_PASSWORD env var is not set");
  return pwd;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITER, KEY_LEN, "sha256");
}

function encrypt(plaintext: string, password: string): string {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(password, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: base64(salt || iv || tag || ciphertext)
  const combined = Buffer.concat([salt, iv, tag, encrypted]);
  return combined.toString("base64");
}

function decrypt(encoded: string, password: string): string {
  const combined = Buffer.from(encoded, "base64");

  const salt = combined.subarray(0, SALT_LEN);
  const iv = combined.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = combined.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = combined.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

export function loadVault(): VaultData {
  if (!existsSync(VAULT_PATH)) {
    return { servers: [] };
  }
  const { data } = JSON.parse(readFileSync(VAULT_PATH, "utf8")) as { data: string };
  const plaintext = decrypt(data, getMasterPassword());
  return JSON.parse(plaintext) as VaultData;
}

export function saveVault(vault: VaultData): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  const plaintext = JSON.stringify(vault);
  const encrypted = encrypt(plaintext, getMasterPassword());
  writeFileSync(VAULT_PATH, JSON.stringify({ data: encrypted }), "utf8");
}
