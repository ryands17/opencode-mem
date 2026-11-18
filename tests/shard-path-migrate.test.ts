import { tursoVectorSearch } from "../src/services/turso/vector-search.js";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory, resetSqldState } from "./turso-test-utils.js";

// Shard path migration does real file swaps of live SQLite files; on a loaded
// Windows box the file-lock release can legitimately exceed the 5s default.
const MIGRATION_TEST_TIMEOUT = 15000;
const migrationTest = (name: string, fn: () => void | Promise<void>) =>
  it(name, fn, MIGRATION_TEST_TIMEOUT);

describe("shard path migration", () => {
  let baseDir: string;
  let oldProjectDir: string;
  let newProjectDir: string;

  afterEach(async () => {
    await resetSqldState();
    await cleanupTursoTestDirectory(baseDir);
  });

  async function createProjects() {
    baseDir = mkdtempSync(join(tmpdir(), "shard-path-migrate-"));
    oldProjectDir = join(baseDir, "old-project");
    newProjectDir = join(baseDir, "new-project");
    mkdirSync(oldProjectDir, { recursive: true });
    mkdirSync(newProjectDir, { recursive: true });
    mkdirSync(join(baseDir, "storage"), { recursive: true });

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = join(baseDir, "storage");
    CONFIG.embeddingDimensions = 2;
    CONFIG.containerTagPrefix = "opencode";
    CONFIG.maxVectorsPerShard = 1000;

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    await tursoConnectionManager.closeAll();
    tursoShardManager.reset();
    await resetSqldState();

    return import("../src/services/tags.js").then((m) => m.getProjectTagInfo);
  }

  async function seedShard(
    projectDir: string,
    memories: Array<{ id: string; content: string; shardIndex?: number }>
  ) {
    const { getProjectTagInfo } = await import("../src/services/tags.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");

    const tag = getProjectTagInfo(projectDir);
    const hash = tag.tag.split("_").pop()!;
    const byIndex = new Map<number, typeof memories>();
    for (const memory of memories) {
      const index = memory.shardIndex ?? 0;
      const list = byIndex.get(index) ?? [];
      list.push(memory);
      byIndex.set(index, list);
    }

    const { CONFIG } = await import("../src/config.js");

    for (const [shardIndex, list] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
      if (shardIndex > 0) {
        const previous = await tursoShardManager.getActiveShard("project", hash);
        if (previous) {
          const metadataDbPath = join(CONFIG.storagePath, "metadata.db");
          const meta = await tursoConnectionManager.getConnection(metadataDbPath);
          await meta.run(`UPDATE shards SET is_active = 0 WHERE id = ?`, [previous.id]);
        }
      }
      const shard = await tursoShardManager.createShard("project", hash, shardIndex);
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      for (const [offset, memory] of list.entries()) {
        await tursoVectorSearch.insertVector(db, {
          id: memory.id,
          content: memory.content,
          vector: new Float32Array([1, offset]),
          containerTag: tag.tag,
          type: "project",
          createdAt: 100 + offset,
          updatedAt: 100 + offset,
          projectPath: projectDir,
          projectName: tag.projectName,
          displayName: tag.displayName,
          tags: "alpha",
        });
        await tursoShardManager.incrementVectorCount(shard.id);
      }
    }

    return { tag, hash };
  }

  migrationTest("migrates orphaned shards and remaps container tags", async () => {
    const getProjectTagInfo = await createProjects();
    const { hash: oldHash } = await seedShard(oldProjectDir, [
      { id: "mem_one", content: "decision one" },
      { id: "mem_two", content: "decision two", shardIndex: 1 },
    ]);
    const { userPromptManager } =
      await import("../src/services/user-prompt/user-prompt-manager.js");
    const promptId = await userPromptManager.savePrompt(
      "session-1",
      "message-1",
      oldProjectDir,
      "How does this project work?"
    );

    // Simulate a directory move: remove the old project directory so only the stored path remains.
    const { rmSync } = await import("node:fs");
    rmSync(oldProjectDir, { recursive: true, force: true });

    const target = getProjectTagInfo(newProjectDir);
    const newHash = target.tag.split("_").pop()!;
    expect(newHash).not.toBe(oldHash);

    const { shardPathMigrationService } =
      await import("../src/services/shard-path-migration-service.js");
    const result = await shardPathMigrationService.migrate({
      currentDirectory: newProjectDir,
      fromPath: oldProjectDir,
      allowLinkedSource: true,
    });

    expect(result.success).toBe(true);
    expect(result.migratedShards).toBe(2);
    expect(result.migratedMemories).toBe(2);

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");

    const oldShards = await tursoShardManager.getAllShards("project", oldHash);
    const newShards = await tursoShardManager.getAllShards("project", newHash);
    expect(oldShards).toHaveLength(0);
    expect(newShards.length).toBeGreaterThanOrEqual(2);

    const allRows = [];
    for (const shard of newShards) {
      expect(shard.dbPath).toMatch(/^sqld:\/\//);
      expect(shard.dbPath).toContain(newHash);
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      allRows.push(...(await tursoVectorSearch.getAllMemories(db)));
    }
    // Both logical shards alias one DB; count distinct rows, not per-shard reads.
    expect(new Set(allRows.map((row) => String(row.id))).size).toBe(2);
    for (const row of allRows) {
      expect(String(row.container_tag)).toBe(target.tag);
      expect(String(row.project_path)).toBe(target.projectPath);
    }

    const listed = await tursoVectorSearch.listMemories(
      await tursoConnectionManager.getConnection(newShards[0]!.dbPath),
      target.tag,
      20
    );
    // list on first shard alone may be partial; check via inventory instead
    const { shardInventoryService } = await import("../src/services/shard-inventory-service.js");
    const inventory = await shardInventoryService.listShards(newProjectDir);
    const current = inventory.shards.find((shard) => shard.scopeHash === newHash);
    expect(current?.memoryCount).toBe(2);
    expect(current?.status).toBe("current");
    expect(listed).toBeDefined();
    expect((await userPromptManager.getPromptById(promptId))?.projectPath).toBe(target.projectPath);
  });

  migrationTest("aborts unchanged when the target project already has memories", async () => {
    const getProjectTagInfo = await createProjects();
    const { hash: oldHash } = await seedShard(oldProjectDir, [
      { id: "mem_old", content: "old memory" },
    ]);
    await seedShard(newProjectDir, [{ id: "mem_new", content: "new memory" }]);

    const { shardPathMigrationService } =
      await import("../src/services/shard-path-migration-service.js");
    const result = await shardPathMigrationService.migrate({
      currentDirectory: newProjectDir,
      fromPath: oldProjectDir,
      allowLinkedSource: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already has");

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");

    const oldShards = await tursoShardManager.getAllShards("project", oldHash);
    expect(oldShards).toHaveLength(1);
    const oldDb = await tursoConnectionManager.getConnection(oldShards[0]!.dbPath);
    const oldRows = await oldDb.all(`SELECT * FROM memories WHERE container_tag = ?`, [
      `opencode_project_${oldHash}`,
    ]);
    expect(oldRows).toHaveLength(1);
    expect(String(oldRows[0]?.id)).toBe("mem_old");

    const newHash = getProjectTagInfo(newProjectDir).tag.split("_").pop()!;
    const newShards = await tursoShardManager.getAllShards("project", newHash);
    const newDb = await tursoConnectionManager.getConnection(newShards[0]!.dbPath);
    const newRows = await newDb.all(`SELECT * FROM memories WHERE instr(container_tag, ?) > 0`, [
      newHash,
    ]);
    expect(newRows).toHaveLength(1);
    expect(String(newRows[0]?.id)).toBe("mem_new");
  });

  migrationTest("archives an empty target shard and completes migration", async () => {
    await createProjects();
    const { getProjectTagInfo } = await import("../src/services/tags.js");
    await seedShard(oldProjectDir, [{ id: "mem_old", content: "old memory" }]);

    const target = getProjectTagInfo(newProjectDir);
    const newHash = target.tag.split("_").pop()!;
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    await tursoShardManager.createShard("project", newHash, 0);

    const { shardPathMigrationService } =
      await import("../src/services/shard-path-migration-service.js");
    const result = await shardPathMigrationService.migrate({
      currentDirectory: newProjectDir,
      fromPath: oldProjectDir,
      allowLinkedSource: true,
    });

    expect(result.success).toBe(true);
    expect(result.migratedMemories).toBe(1);
    const newShards = await tursoShardManager.getAllShards("project", newHash);
    expect(newShards).toHaveLength(1);
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const rows = await (
      await tursoConnectionManager.getConnection(newShards[0]!.dbPath)
    ).all(`SELECT * FROM memories WHERE instr(container_tag, ?) > 0`, [newHash]);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.container_tag)).toBe(target.tag);
  });

  migrationTest("supports dry-run without mutating shards", async () => {
    await createProjects();
    const { hash: oldHash } = await seedShard(oldProjectDir, [
      { id: "mem_old", content: "old memory" },
    ]);

    const { shardPathMigrationService } =
      await import("../src/services/shard-path-migration-service.js");
    const result = await shardPathMigrationService.migrate({
      currentDirectory: newProjectDir,
      fromPath: oldProjectDir,
      dryRun: true,
      allowLinkedSource: true,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.migratedMemories).toBe(1);

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const oldShards = await tursoShardManager.getAllShards("project", oldHash);
    expect(oldShards).toHaveLength(1);
    expect(oldShards[0]!.dbPath).toMatch(/^sqld:\/\//);
  });

  migrationTest(
    "aborts ownership loss during staging with originals and registry unchanged",
    async () => {
      const getProjectTagInfo = await createProjects();
      const { tag, hash } = await seedShard(oldProjectDir, [
        { id: "one", content: "first" },
        { id: "two", content: "second", shardIndex: 1 },
      ]);
      const { CONFIG } = await import("../src/config.js");
      const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
      const { tursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");
      const originals = await tursoShardManager.getAllShards("project", hash);
      const update = tursoVectorSearch.updateProjectAssociation;
      const lockPath = join(CONFIG.storagePath, ".turso-operation.lock");
      let staged = 0;
      tursoVectorSearch.updateProjectAssociation = async function (...args) {
        const result = await update.apply(this, args);
        staged++;
        writeFileSync(lockPath, JSON.stringify({ pid: 2147483647 }));
        return result;
      };
      try {
        const { shardPathMigrationService } =
          await import("../src/services/shard-path-migration-service.js");
        const result = await shardPathMigrationService.migrate({
          currentDirectory: newProjectDir,
          fromHash: hash,
          allowLinkedSource: true,
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("ownership lost");
      } finally {
        tursoVectorSearch.updateProjectAssociation = update;
      }
      expect(staged).toBeGreaterThanOrEqual(1);
      expect(await tursoShardManager.getAllShards("project", hash)).toEqual(originals);
      const newHash = getProjectTagInfo(newProjectDir).tag.split("_").pop()!;
      expect(await tursoShardManager.getAllShards("project", newHash)).toHaveLength(0);
      const rows = await (
        await tursoConnectionManager.getConnection(originals[0]!.dbPath)
      ).all(`SELECT * FROM memories WHERE instr(container_tag, ?) > 0`, [hash]);
      expect(new Set(rows.map((row) => String(row.id))).size).toBe(2);
      for (const row of rows) {
        expect(row.container_tag).toBe(tag.tag);
        expect(row.project_path).toBe(oldProjectDir);
      }
      expect(existsSync(join(CONFIG.storagePath, ".path-migrate-swap.json"))).toBe(false);
      expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(2147483647);
    }
  );

  migrationTest("refuses to migrate a still-linked source unless explicitly allowed", async () => {
    await createProjects();
    const { hash: oldHash } = await seedShard(oldProjectDir, [
      { id: "mem_linked", content: "linked memory" },
    ]);

    const { shardPathMigrationService } =
      await import("../src/services/shard-path-migration-service.js");
    const refused = await shardPathMigrationService.migrate({
      currentDirectory: newProjectDir,
      fromHash: oldHash,
    });

    expect(refused.success).toBe(false);
    expect(refused.error).toContain("source project path still exists");

    const allowed = await shardPathMigrationService.migrate({
      currentDirectory: newProjectDir,
      fromHash: oldHash,
      allowLinkedSource: true,
      dryRun: true,
    });
    expect(allowed.success).toBe(true);
  });

  migrationTest(
    "updates stored Windows prompt paths using separator-independent matching",
    async () => {
      await createProjects();
      const { userPromptManager } =
        await import("../src/services/user-prompt/user-prompt-manager.js");
      const promptId = await userPromptManager.savePrompt(
        "windows-session",
        "windows-message",
        "C:\\workspace\\old-project",
        "Windows path prompt"
      );

      const updated = await userPromptManager.updateProjectPath(
        "C:/workspace/old-project",
        "C:\\workspace\\new-project"
      );

      expect(updated).toBe(1);
      expect((await userPromptManager.getPromptById(promptId))?.projectPath).toBe(
        "C:\\workspace\\new-project"
      );
    }
  );
});
