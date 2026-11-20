import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory, resetSqldState } from "./turso-test-utils.js";

describe("api memory shard scope", () => {
  let baseDir: string;

  afterEach(async () => {
    await resetSqldState();
    await cleanupTursoTestDirectory(baseDir);
  });

  it("includes user-scope memories in stats, pin, and global search handlers", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-api-scope-"));

    const { CONFIG } = await import("../src/config.js");
    const previousEmbeddingConfig = {
      embeddingApiUrl: CONFIG.embeddingApiUrl,
      embeddingApiKey: CONFIG.embeddingApiKey,
    };
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;

    const vector = new Float32Array(768);
    vector[0] = 1;

    const embeddingServer = Bun.serve({
      port: 0,
      async fetch() {
        return new Response(JSON.stringify({ data: [{ embedding: Array.from(vector) }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    CONFIG.embeddingApiUrl = embeddingServer.url;
    CONFIG.embeddingApiKey = "turso-api-scope-test-key";

    try {
      const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
      await closeTursoAndInvalidateCaches();
      await resetSqldState();

      const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
      const { tursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");
      const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
      const { handleStats, handlePinMemory, handleSearch } =
        await import("../src/services/api-handlers.js");

      const scopeHash = "c1c2c3d4e5f67890";
      const containerTag = `opencode_user_${scopeHash}`;

      const shard = await tursoShardManager.createShard("user", scopeHash, 0);
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      await tursoVectorSearch.insertVector(db, {
        id: "mem_user_scope_1",
        content: "user scoped memory",
        vector,
        containerTag,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const stats = await handleStats();
      expect(stats.success).toBe(true);
      expect(stats.data?.byScope.user).toBe(1);
      expect(stats.data?.total).toBe(1);

      const pin = await handlePinMemory("mem_user_scope_1");
      expect(pin.success).toBe(true);

      const pinned = await tursoVectorSearch.getMemoryById(db, "mem_user_scope_1");
      expect(Number(pinned?.is_pinned)).toBe(1);

      const search = await handleSearch("user scoped memory");
      expect(search.success).toBe(true);
      expect(search.data?.items.some((item) => item.id === "mem_user_scope_1")).toBe(true);
    } finally {
      embeddingServer.stop(true);
      Object.assign(CONFIG, previousEmbeddingConfig);
    }
  });
});
