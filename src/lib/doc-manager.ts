/**
 * Per-server Markdown documentation manager.
 * Docs live at: data/docs/{server-name}.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "../../data/docs");

function ensureDocsDir(): void {
  if (!existsSync(DOCS_DIR)) {
    mkdirSync(DOCS_DIR, { recursive: true });
  }
}

function docPath(serverName: string): string {
  // Sanitize name to prevent path traversal
  const safe = serverName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(DOCS_DIR, `${safe}.md`);
}

export function getServerDocs(serverName: string): string | null {
  const path = docPath(serverName);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function updateServerDocs(serverName: string, content: string): void {
  ensureDocsDir();
  writeFileSync(docPath(serverName), content, "utf8");
}

export function listDocumentedServers(): string[] {
  ensureDocsDir();
  return readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}
