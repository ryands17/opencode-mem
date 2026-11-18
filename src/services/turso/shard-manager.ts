import { basename } from "node:path";
import { CONFIG } from "../../config.js";
import { assertSafeScopeHash } from "../memory-scope.js";
import { tursoConnectionManager } from "./connection-manager.js";
import { log } from "../logger.js";
import type { ShardInfo } from "./types.js";
import type { TursoDb } from "./turso-db.js";
import { applySchemaMigrations, memoryShardMigrations } from "./schema-migrations.js";

const SHARD_DB_KEY = "sqld:main";

const REGISTRY_DDL = `
  CREATE TABLE IF NOT EXISTS shards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    shard_index INTEGER NOT NULL,
    db_path TEXT NOT NULL,
    vector_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(scope, scope_hash, shard_index)
  )
`;

function getValidatedEmbeddingDimensions(dimensions = CONFIG.embeddingDimensions): number {
  const dims = dimensions;
  if (!Number.isInteger(dims) || dims <= 0 || dims > 65536) {
    throw new Error(`Invalid embeddingDimensions config: ${dims}`);
  }
  return dims;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed") || message.includes("SQLITE_CONSTRAINT");
}

export class TursoShardManager {
  private db: TursoDb | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  reset(): void {
    this.db = null;
    this.initPromise = null;
    this.writeLocks.clear();
  }

  async withScopeWriteLock<T>(
    scope: "user" | "project",
    scopeHash: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = `${scope}:${scopeHash}`;
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    this.writeLocks.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.writeLocks.get(key) === next) {
        this.writeLocks.delete(key);
      }
    }
  }

  private async ensureInitialized(): Promise<TursoDb> {
    if (this.initPromise) await this.initPromise;
    if (this.db) return this.db;

    this.initPromise = (async () => {
      try {
        const db = await tursoConnectionManager.getConnection(SHARD_DB_KEY);
        await db.execute(REGISTRY_DDL);
        await db.execute(
          `CREATE INDEX IF NOT EXISTS idx_active_shards ON shards(scope, scope_hash, is_active)`
        );
        this.db = db;
      } catch (error) {
        this.initPromise = null;
        this.db = null;
        throw error;
      }
    })();

    await this.initPromise;
    return this.db!;
  }

  /** Logical shard key. There is one sqld database; this is not a file path. */
  getShardPath(scope: "user" | "project", scopeHash: string, shardIndex: number): string {
    assertSafeScopeHash(scopeHash);
    return `sqld://${scope}/${scopeHash}/shard_${shardIndex}`;
  }

  private scopeSuffix(scope: "user" | "project", scopeHash: string): string {
    return `${scope}_${scopeHash}`;
  }

  async getActiveShard(scope: "user" | "project", scopeHash: string): Promise<ShardInfo | null> {
    const db = await this.ensureInitialized();
    const row = await db.get(
      `SELECT * FROM shards WHERE scope = ? AND scope_hash = ? AND is_active = 1
       ORDER BY shard_index DESC LIMIT 1`,
      [scope, scopeHash]
    );
    return row ? this.rowToShardInfo(row) : null;
  }

  async getAllShards(scope: "user" | "project", scopeHash: string): Promise<ShardInfo[]> {
    const db = await this.ensureInitialized();
    const rows =
      scopeHash === ""
        ? await db.all(`SELECT * FROM shards WHERE scope = ? ORDER BY shard_index ASC`, [scope])
        : await db.all(
            `SELECT * FROM shards WHERE scope = ? AND scope_hash = ? ORDER BY shard_index ASC`,
            [scope, scopeHash]
          );
    return rows.map((row) => this.rowToShardInfo(row));
  }

  async createShard(
    scope: "user" | "project",
    scopeHash: string,
    shardIndex: number
  ): Promise<ShardInfo> {
    const db = await this.ensureInitialized();
    const shardPath = this.getShardPath(scope, scopeHash, shardIndex);
    const storedPath = `${scope}_${scopeHash}_shard_${shardIndex}`;
    const now = Date.now();

    await this.initShardDb(db);

    let result;
    try {
      result = await db.execute(
        `INSERT INTO shards (scope, scope_hash, shard_index, db_path, vector_count, is_active, created_at)
         VALUES (?, ?, ?, ?, 0, 1, ?)`,
        [scope, scopeHash, shardIndex, storedPath, now]
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await db.get(
          `SELECT * FROM shards WHERE scope = ? AND scope_hash = ? AND shard_index = ?`,
          [scope, scopeHash, shardIndex]
        );
        if (existing) return this.rowToShardInfo(existing);
      }
      throw error;
    }

    return {
      id: Number(result.lastInsertRowid),
      scope,
      scopeHash,
      shardIndex,
      dbPath: shardPath,
      vectorCount: 0,
      isActive: true,
      createdAt: now,
    };
  }

  async registerExistingShard(
    scope: "user" | "project",
    scopeHash: string,
    shardIndex: number,
    dbPath: string,
    vectorCount: number,
    isActive: boolean
  ): Promise<ShardInfo> {
    assertSafeScopeHash(scopeHash);
    const db = await this.ensureInitialized();
    const storedPath = `${scope}_${scopeHash}_shard_${shardIndex}`;
    const now = Date.now();

    await db.execute(
      `INSERT INTO shards (scope, scope_hash, shard_index, db_path, vector_count, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_hash, shard_index) DO UPDATE SET
         db_path = excluded.db_path,
         vector_count = excluded.vector_count,
         is_active = excluded.is_active`,
      [scope, scopeHash, shardIndex, storedPath, vectorCount, isActive ? 1 : 0, now]
    );

    const row = await db.get(
      `SELECT * FROM shards WHERE scope = ? AND scope_hash = ? AND shard_index = ?`,
      [scope, scopeHash, shardIndex]
    );
    if (!row) throw new Error(`Failed to register shard ${scope}/${scopeHash}#${shardIndex}`);
    return this.rowToShardInfo(row);
  }

  async initShardDb(
    db: TursoDb,
    dimensions = CONFIG.embeddingDimensions,
    embeddingModel = CONFIG.embeddingModel
  ): Promise<void> {
    const dims = getValidatedEmbeddingDimensions(dimensions);
    await this.ensureShardSchema(db, dims);
    await db.batch([
      {
        sql: `INSERT OR REPLACE INTO shard_metadata (key, value) VALUES ('embedding_dimensions', ?)`,
        args: [String(dims)],
      },
      {
        sql: `INSERT OR REPLACE INTO shard_metadata (key, value) VALUES ('embedding_model', ?)`,
        args: [embeddingModel],
      },
    ]);
  }

  async ensureShardSchema(db: TursoDb, dimensions = CONFIG.embeddingDimensions): Promise<void> {
    const dims = getValidatedEmbeddingDimensions(dimensions);
    await applySchemaMigrations(db, memoryShardMigrations(dims), { label: "memory-shard" });
  }

  private rowToShardInfo(row: Record<string, unknown>): ShardInfo {
    const scope = String(row.scope) as "user" | "project";
    const scopeHash = String(row.scope_hash);
    const shardIndex = Number(row.shard_index);
    return {
      id: Number(row.id),
      scope,
      scopeHash,
      shardIndex,
      dbPath: this.getShardPath(scope, scopeHash, shardIndex),
      vectorCount: Number(row.vector_count),
      isActive: Number(row.is_active) === 1,
      createdAt: Number(row.created_at),
    };
  }

  private async hasMatchingEmbeddingDimensions(db: TursoDb, shard: ShardInfo): Promise<boolean> {
    const row = await db.get(`SELECT value FROM shard_metadata WHERE key = 'embedding_dimensions'`);
    if (!row?.value) {
      log("Shard missing embedding_dimensions metadata", { shardId: shard.id });
      return false;
    }
    const storedDimensions = Number(row.value);
    if (storedDimensions !== getValidatedEmbeddingDimensions()) {
      log("Shard embedding dimensions mismatch", {
        shardId: shard.id,
        storedDimensions,
        configDimensions: CONFIG.embeddingDimensions,
      });
      return false;
    }
    return true;
  }

  private async syncShardVectorCount(shard: ShardInfo): Promise<ShardInfo> {
    const db = await this.ensureInitialized();
    const row = await db.get(`SELECT COUNT(*) as count FROM memories`);
    const count = Number(row?.count ?? 0);
    if (count === shard.vectorCount) return shard;
    await db.run(`UPDATE shards SET vector_count = ? WHERE id = ?`, [count, shard.id]);
    return { ...shard, vectorCount: count };
  }

  private async isShardValid(shard: ShardInfo): Promise<boolean> {
    try {
      const db = await this.ensureInitialized();
      const result = await db.get(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`
      );
      return Boolean(result) && (await this.hasMatchingEmbeddingDimensions(db, shard));
    } catch (error) {
      log("Error validating shard", { shardId: shard.id, error: String(error) });
      return false;
    }
  }

  async getWriteShard(scope: "user" | "project", scopeHash: string): Promise<ShardInfo> {
    let shard = await this.getActiveShard(scope, scopeHash);
    if (!shard) return this.createShard(scope, scopeHash, 0);
    if (!(await this.isShardValid(shard))) {
      throw new Error(
        `Memory store is incompatible or corrupt (shard ${scope}/${scopeHash}). ` +
          `Run the model migration or restore the sqld database before writing.`
      );
    }
    shard = await this.syncShardVectorCount(shard);
    return shard;
  }

  async incrementVectorCount(shardId: number): Promise<void> {
    const db = await this.ensureInitialized();
    await db.run(`UPDATE shards SET vector_count = vector_count + 1 WHERE id = ?`, [shardId]);
  }

  async decrementVectorCount(shardId: number): Promise<void> {
    const db = await this.ensureInitialized();
    await db.run(
      `UPDATE shards SET vector_count = vector_count - 1 WHERE id = ? AND vector_count > 0`,
      [shardId]
    );
  }

  async setVectorCount(shardId: number, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0) throw new Error(`Invalid vector count: ${count}`);
    const db = await this.ensureInitialized();
    await db.run(`UPDATE shards SET vector_count = ? WHERE id = ?`, [count, shardId]);
  }

  async getShardById(shardId: number): Promise<ShardInfo | null> {
    const db = await this.ensureInitialized();
    const row = await db.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);
    return row ? this.rowToShardInfo(row) : null;
  }

  async getShardByPath(dbPath: string): Promise<ShardInfo | null> {
    const db = await this.ensureInitialized();
    const match = dbPath.match(/(user|project)_([a-f0-9]{16})_shard_(\d+)/);
    if (!match) return null;
    const row = await db.get(
      `SELECT * FROM shards WHERE scope = ? AND scope_hash = ? AND shard_index = ?`,
      [match[1]!, match[2]!, Number(match[3])]
    );
    return row ? this.rowToShardInfo(row) : null;
  }

  async deleteShard(shardId: number): Promise<void> {
    const db = await this.ensureInitialized();
    const row = await db.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);
    if (!row) return;
    await db.run(`DELETE FROM memories WHERE instr(container_tag, ?) > 0`, [
      this.scopeSuffix(String(row.scope) as "user" | "project", String(row.scope_hash)),
    ]);
    await db.run(`DELETE FROM shards WHERE id = ?`, [shardId]);
  }

  /** Removes only the registry row; memories in the shared DB are untouched. */
  async removeShardRegistry(shardId: number): Promise<void> {
    const db = await this.ensureInitialized();
    await db.run(`DELETE FROM shards WHERE id = ?`, [shardId]);
  }

  async archiveShard(
    shardId: number,
    reason: string,
    archivePathOverride?: string
  ): Promise<string | null> {
    await this.deleteShard(shardId);
    log("Archived logical shard in sqld", { shardId, reason, archivePathOverride });
    return `sqld://shard/${shardId}/archived/${reason}`;
  }

  async reassignShardScope(
    shardId: number,
    newScopeHash: string,
    newDbPath: string,
    vectorCount: number,
    isActive: boolean
  ): Promise<ShardInfo> {
    assertSafeScopeHash(newScopeHash);
    const db = await this.ensureInitialized();
    const row = await db.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);
    if (!row) throw new Error(`Shard ${shardId} not found in metadata registry`);

    const scope = String(row.scope) as "user" | "project";
    const oldSuffix = this.scopeSuffix(scope, String(row.scope_hash));
    const newSuffix = this.scopeSuffix(scope, newScopeHash);
    await db.run(
      `UPDATE memories SET container_tag = replace(container_tag, ?, ?) WHERE instr(container_tag, ?) > 0`,
      [oldSuffix, newSuffix, oldSuffix]
    );

    await db.run(
      `UPDATE shards SET scope_hash = ?, db_path = ?, vector_count = ?, is_active = ? WHERE id = ?`,
      [
        newScopeHash,
        basename(newDbPath).replace(/\.db$/, ""),
        vectorCount,
        isActive ? 1 : 0,
        shardId,
      ]
    );

    const updated = await db.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);
    if (!updated) throw new Error(`Failed to reassign shard ${shardId}`);
    return this.rowToShardInfo(updated);
  }
}

export const tursoShardManager = new TursoShardManager();
