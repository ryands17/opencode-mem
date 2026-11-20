import { rmSync } from "node:fs";
import { createClient } from "@libsql/client/web";
import { RETRYABLE_FILE_LOCK_CODES } from "../src/services/turso/sqlite-handle-release.js";

export function requiredTestSqldUrl(): string {
  const url = process.env.OPENCODE_MEM_TEST_SQLD_URL;
  if (!url) {
    throw new Error(
      "OPENCODE_MEM_TEST_SQLD_URL must point at a dedicated test sqld. Tests refuse the default http://127.0.0.1:8080 — it may be a live plugin database. Start an isolated sqld (e.g. docker run -d -p 8081:8080 -e SQLD_NODE=primary -e SQLD_DB_PATH=test.db ghcr.io/tursodatabase/libsql-server) and export OPENCODE_MEM_TEST_SQLD_URL=http://127.0.0.1:8081."
    );
  }
  return url;
}

export async function resetSqldState(): Promise<void> {
  const client = createClient({
    url: requiredTestSqldUrl(),
    concurrency: 1,
  });
  try {
    const tables = (
      await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).rows
      .map((row) => String(row.name))
      .filter((name) => !name.startsWith("sqlite_"));
    for (const table of tables) await client.execute(`DROP TABLE IF EXISTS "${table}"`);
  } finally {
    client.close();
  }
}

export async function cleanupTursoTestDirectory(baseDir?: string): Promise<void> {
  const [{ closeTursoAndInvalidateCaches }, { withSqliteFileLockRetry }] = await Promise.all([
    import("../src/services/turso/lifecycle.js"),
    import("../src/services/turso/sqlite-handle-release.js"),
  ]);

  await closeTursoAndInvalidateCaches();
  if (baseDir) {
    try {
      // WARNING: keep the bounded retry — libsql keeps handles alive until GC, so a file can stay locked long enough to flake test hooks under parallel load.
      await withSqliteFileLockRetry(() => rmSync(baseDir, { recursive: true, force: true }), 1);
    } catch (error) {
      if (isExhaustedWindowsLock(error)) {
        console.warn(`cleanupTursoTestDirectory: could not remove ${baseDir}`, error);
        return;
      }
      throw error;
    }
  }
}

export function isExhaustedWindowsLock(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (process.platform !== "win32" || !code) return false;
  return RETRYABLE_FILE_LOCK_CODES.has(code);
}
