import { rmSync } from "node:fs";
import { createClient } from "@libsql/client/web";
import { RETRYABLE_FILE_LOCK_CODES } from "../src/services/turso/sqlite-handle-release.js";

/**
 * All logical databases share one sqld server, so tests must reset state
 * themselves. Tables are dropped (not just emptied) because tests use different
 * embedding dimensions and schema versions.
 */
export async function resetSqldState(): Promise<void> {
  const client = createClient({
    url: process.env.OPENCODE_MEM_TEST_SQLD_URL ?? "http://127.0.0.1:8080",
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
      // Bounded retry: libsql 0.5.x keeps handles alive until GC, so a file can
      // stay locked long enough to blow a 5-10s test hook under parallel load.
      // A lock error on Windows can only escape the retry with its budget
      // exhausted, so that is the sole path worth warning about.
      await withSqliteFileLockRetry(() => rmSync(baseDir, { recursive: true, force: true }), 1);
    } catch (error) {
      if (isExhaustedWindowsLock(error)) {
        // Best-effort hygiene only: each test uses a unique mkdtemp dir, so a
        // leftover is harmless garbage, not a suite failure.
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
