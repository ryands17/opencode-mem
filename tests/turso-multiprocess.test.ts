import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("sqlite sidecars include -tshm", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("rename/copy/remove move -wal -shm and -tshm together", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-tshm-"));
    const { copySqliteDatabase, renameSqliteDatabase, removeSqliteDatabase } =
      await import("../src/services/turso/sqlite-handle-release.js");

    const src = join(baseDir, "src.db");
    const dst = join(baseDir, "dst.db");
    const renamed = join(baseDir, "renamed.db");
    writeFileSync(src, "main");
    writeFileSync(`${src}-wal`, "wal");
    writeFileSync(`${src}-shm`, "shm");
    writeFileSync(`${src}-tshm`, "tshm");

    copySqliteDatabase(src, dst);
    expect(existsSync(dst)).toBe(true);
    expect(existsSync(`${dst}-wal`)).toBe(true);
    expect(existsSync(`${dst}-shm`)).toBe(true);
    expect(existsSync(`${dst}-tshm`)).toBe(true);

    renameSqliteDatabase(dst, renamed);
    expect(existsSync(renamed)).toBe(true);
    expect(existsSync(`${renamed}-tshm`)).toBe(true);
    expect(existsSync(dst)).toBe(false);
    expect(existsSync(`${dst}-tshm`)).toBe(false);

    removeSqliteDatabase(renamed);
    expect(existsSync(renamed)).toBe(false);
    expect(existsSync(`${renamed}-wal`)).toBe(false);
    expect(existsSync(`${renamed}-shm`)).toBe(false);
    expect(existsSync(`${renamed}-tshm`)).toBe(false);
  });
});
