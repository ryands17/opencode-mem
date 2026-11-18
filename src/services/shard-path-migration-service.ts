import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { CONFIG } from "../config.js";
import { extractScopeFromContainerTag } from "./memory-scope.js";
import { getProjectTagInfo } from "./tags.js";
import { ensureTursoReady } from "./turso/ready.js";
import {
  acquireTursoOperationLock,
  isTursoLockOwnershipLostError,
} from "./turso/operation-lock.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import {
  withSqliteFileLockRetry,
  renameSqliteDatabase,
  removeSqliteDatabase,
} from "./turso/sqlite-handle-release.js";
import { log } from "./logger.js";
import {
  shardInventoryService,
  type ResolveMigrationSourceOptions,
  type ResolvedMigrationSource,
} from "./shard-inventory-service.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";

export interface PathMigrationOptions extends ResolveMigrationSourceOptions {
  currentDirectory: string;
  dryRun?: boolean;
  allowLinkedSource?: boolean;
}

export interface PathMigrationAction {
  type:
    "rename" | "archive-empty-target" | "update-memories" | "update-prompts" | "reassign-metadata";
  detail: string;
}

export interface PathMigrationResult {
  success: boolean;
  dryRun: boolean;
  migratedShards?: number;
  migratedMemories?: number;
  oldPath?: string | null;
  newPath?: string;
  oldHash?: string;
  newHash?: string;
  matchedBy?: ResolvedMigrationSource["matchedBy"];
  actions?: PathMigrationAction[];
  error?: string;
  candidates?: unknown[];
}

interface ShardMove {
  shardId: number;
  shardIndex: number;
  oldPath: string;
  newPath: string;
  stagedPath: string;
  backupPath: string;
  isActive: boolean;
  vectorCount: number;
  oldContainerTag: string;
}

interface ArchivedTarget {
  shardId: number;
  shardIndex: number;
  originalPath: string;
  archivePath: string | null;
  isActive: boolean;
  vectorCount: number;
}

interface PathMigrateSwapState {
  operation: "path-migrate";
  oldHash: string;
  newHash: string;
  moves: ShardMove[];
  archivedTargets: ArchivedTarget[];
}

function swapStatePath(): string {
  return join(CONFIG.storagePath, ".path-migrate-swap.json");
}

function writeSwapState(path: string, state: PathMigrateSwapState): void {
  writeFileSync(path, JSON.stringify(state), "utf-8");
}

function assertRecoveryPathInsideStorage(path: string): void {
  const rel = relative(resolve(CONFIG.storagePath), resolve(path));
  if (rel === "" || rel.startsWith("..") || rel.includes("\0")) {
    throw new Error(`Path-migrate recovery path escapes storage: ${path}`);
  }
}

async function countLiveMemories(dbPath: string): Promise<number> {
  const db = await tursoConnectionManager.getConnection(dbPath);
  const match = /^sqld:\/\/(user|project)\/([a-f0-9]{16})\//.exec(dbPath);
  const row = match
    ? await db.get(
        `SELECT COUNT(*) AS n FROM memories WHERE instr(container_tag, ?) > 0 AND deleted_at IS NULL`,
        [`${match[1]}_${match[2]}`]
      )
    : await db.get(`SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL`);
  return Number(row?.n ?? 0);
}

async function removeFile(path: string): Promise<void> {
  await tursoConnectionManager.closeConnection(path);
  if (existsSync(path)) {
    await withSqliteFileLockRetry(() => removeSqliteDatabase(path));
  }
}

export class ShardPathMigrationService {
  async migrate(options: PathMigrationOptions): Promise<PathMigrationResult> {
    await ensureTursoReady();

    const target = getProjectTagInfo(options.currentDirectory);
    const newHash = extractScopeFromContainerTag(target.tag).hash;
    const resolveResult = await shardInventoryService.resolveMigrationSource(
      options.currentDirectory,
      { fromPath: options.fromPath, fromHash: options.fromHash }
    );

    if (!resolveResult.success || !resolveResult.source) {
      return {
        success: false,
        dryRun: Boolean(options.dryRun),
        error: resolveResult.error,
        candidates: resolveResult.candidates,
      };
    }

    const source = resolveResult.source;
    const oldHash = source.scopeHash;
    const resultBase = {
      dryRun: Boolean(options.dryRun),
      oldHash,
      newHash,
      oldPath: source.group.projectPath,
      newPath: target.projectPath,
      matchedBy: source.matchedBy,
    };

    if (oldHash === newHash) {
      return {
        success: true,
        ...resultBase,
        migratedShards: 0,
        migratedMemories: 0,
        actions: [],
      };
    }

    if (source.group.pathExists && !options.allowLinkedSource) {
      return {
        success: false,
        ...resultBase,
        error:
          `Migration refused: source project path still exists (${source.group.projectPath}). ` +
          "Set allowLinkedSource: true only after confirming that this active project should be reassociated.",
      };
    }

    // Inventory may discover a valid shard added after startup reconciliation.
    // Register it so list-shards and migrate operate on the same set.
    for (const descriptor of source.group.shards) {
      if (descriptor.shardId === null && descriptor.fileExists) {
        await tursoShardManager.registerExistingShard(
          "project",
          oldHash,
          descriptor.shardIndex,
          descriptor.dbPath,
          descriptor.memoryCount,
          descriptor.isActive
        );
      }
    }

    const sourceShards = await tursoShardManager.getAllShards("project", oldHash);
    if (sourceShards.length === 0) {
      return {
        success: false,
        ...resultBase,
        error: `No usable shards found for source hash ${oldHash}`,
      };
    }

    // Strict conflict policy: any non-empty target aborts unchanged.
    const targetShards = await tursoShardManager.getAllShards("project", newHash);
    for (const shard of targetShards) {
      const liveCount = await countLiveMemories(shard.dbPath);
      if (liveCount > 0 || shard.vectorCount > 0) {
        return {
          success: false,
          ...resultBase,
          error:
            `Migration aborted: target project already has ${Math.max(liveCount, shard.vectorCount)} memories ` +
            `(shard ${basename(shard.dbPath)}). Delete or forget those memories first, or use export/import.`,
        };
      }
    }

    const oldContainerTag =
      source.group.containerTag ?? `${CONFIG.containerTagPrefix}_project_${oldHash}`;
    const nonce = `${process.pid}-${Date.now()}`;
    const moves: ShardMove[] = sourceShards.map((shard) => {
      const newPath = tursoShardManager.getShardPath("project", newHash, shard.shardIndex);
      const inventoryShard = source.group.shards.find(
        (candidate) => candidate.shardIndex === shard.shardIndex
      );
      return {
        shardId: shard.id,
        shardIndex: shard.shardIndex,
        oldPath: shard.dbPath,
        newPath,
        stagedPath: `${newPath}.path-migrate-${nonce}.tmp`,
        backupPath: `${shard.dbPath}.pre-path-migrate-${nonce}.bak`,
        isActive: shard.isActive,
        vectorCount: inventoryShard?.memoryCount ?? shard.vectorCount,
        oldContainerTag,
      };
    });

    for (const move of moves) {
      if (existsSync(move.newPath) && !targetShards.some((s) => s.dbPath === move.newPath)) {
        if ((await countLiveMemories(move.newPath)) > 0) {
          return {
            success: false,
            ...resultBase,
            error: `Migration aborted: target shard file already contains memories (${basename(move.newPath)}).`,
          };
        }
      }
    }

    const actions: PathMigrationAction[] = moves.map((move) => ({
      type: "rename",
      detail: `${basename(move.oldPath)} -> ${basename(move.newPath)}`,
    }));
    for (const shard of targetShards) {
      actions.push({ type: "archive-empty-target", detail: basename(shard.dbPath) });
    }
    // All source shards share one logical database and container tag, so count
    // once instead of once per shard (which would double-count every row).
    const migratedMemories = moves.length > 0 ? await countLiveMemories(moves[0]!.oldPath) : 0;
    actions.push({
      type: "update-memories",
      detail: `Remap container_tag and project metadata for ${migratedMemories} memories`,
    });
    if (source.group.projectPath && target.projectPath) {
      actions.push({
        type: "update-prompts",
        detail: `${source.group.projectPath} -> ${target.projectPath}`,
      });
    }

    if (options.dryRun) {
      return {
        success: true,
        ...resultBase,
        migratedShards: moves.length,
        migratedMemories,
        actions,
      };
    }

    const releaseLock = acquireTursoOperationLock("path-migrate");
    const processedMoves: ShardMove[] = [];
    try {
      const db = await tursoConnectionManager.getConnection(moves[0]!.oldPath);
      for (const move of moves) {
        await tursoVectorSearch.updateProjectAssociation(db, move.oldContainerTag, {
          containerTag: target.tag,
          projectPath: target.projectPath,
          projectName: target.projectName,
          displayName: target.displayName,
          gitRepoUrl: target.gitRepoUrl ?? null,
        });
        processedMoves.push(move);
        releaseLock.heartbeat();
      }

      for (const shard of targetShards) {
        // Targets are empty (strict conflict check above). Removing only the
        // registry row avoids deleting source memories, which share the DB.
        await tursoShardManager.removeShardRegistry(shard.id);
        releaseLock.heartbeat();
      }

      for (const move of moves) {
        await tursoShardManager.reassignShardScope(
          move.shardId,
          newHash,
          move.newPath,
          move.vectorCount,
          move.isActive
        );
        actions.push({
          type: "reassign-metadata",
          detail: `shard ${move.shardId} -> ${newHash}#${move.shardIndex}`,
        });
        releaseLock.heartbeat();
      }

      // Prompt metadata is secondary and must not invalidate a completed,
      // recoverable memory migration.
      if (source.group.projectPath && target.projectPath) {
        try {
          await userPromptManager.updateProjectPath(source.group.projectPath, target.projectPath);
        } catch (error) {
          log("Path migration prompt metadata update failed", { error: String(error) });
        }
      }

      log("Path migration completed", {
        oldHash,
        newHash,
        migratedShards: moves.length,
        migratedMemories,
      });
      return {
        success: true,
        ...resultBase,
        dryRun: false,
        migratedShards: moves.length,
        migratedMemories,
        actions,
      };
    } catch (error) {
      // Restore already-remapped rows: everything shares one database, so a
      // partial update would otherwise leave source memories under the target tag.
      if (processedMoves.length > 0) {
        const db = await tursoConnectionManager.getConnection(moves[0]!.oldPath);
        for (const move of [...processedMoves].reverse()) {
          await tursoVectorSearch.updateProjectAssociation(db, target.tag, {
            containerTag: move.oldContainerTag,
            projectPath: source.group.projectPath ?? undefined,
            projectName: source.group.projectName ?? undefined,
            displayName: source.group.projectName ?? undefined,
            gitRepoUrl: source.group.gitRepoUrl ?? null,
          });
        }
      }
      const ownershipLost = isTursoLockOwnershipLostError(error);
      log("Path migration failed", { error: String(error), ownershipLost });
      return {
        success: false,
        ...resultBase,
        dryRun: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      releaseLock();
    }
  }

  private async rollbackSwap(state: PathMigrateSwapState, statePath: string): Promise<void> {
    let rollbackFailed = false;

    for (const move of [...state.moves].reverse()) {
      try {
        await tursoConnectionManager.closeConnection(move.newPath);
        await tursoConnectionManager.closeConnection(move.stagedPath);
        if (existsSync(move.backupPath)) {
          await removeFile(move.newPath);
          await removeFile(move.oldPath);
          await withSqliteFileLockRetry(() => renameSqliteDatabase(move.backupPath, move.oldPath));
        }
        await removeFile(move.stagedPath);
        if (existsSync(move.oldPath)) {
          await tursoShardManager.reassignShardScope(
            move.shardId,
            state.oldHash,
            move.oldPath,
            move.vectorCount,
            move.isActive
          );
        }
      } catch (error) {
        rollbackFailed = true;
        log("Path migration source rollback failed", { move, error: String(error) });
      }
    }

    for (const archived of state.archivedTargets) {
      try {
        if (archived.archivePath && existsSync(archived.archivePath)) {
          await removeFile(archived.originalPath);
          await withSqliteFileLockRetry(() =>
            renameSqliteDatabase(archived.archivePath!, archived.originalPath)
          );
          await tursoShardManager.registerExistingShard(
            "project",
            state.newHash,
            archived.shardIndex,
            archived.originalPath,
            archived.vectorCount,
            archived.isActive
          );
        }
      } catch (error) {
        rollbackFailed = true;
        log("Path migration target rollback failed", { archived, error: String(error) });
      }
    }

    if (!rollbackFailed && existsSync(statePath)) {
      unlinkSync(statePath);
    } else if (rollbackFailed && !existsSync(statePath)) {
      writeSwapState(statePath, state);
    }
  }

  /** Roll back an interrupted staged swap before normal storage access resumes. */
  async recoverInterruptedSwap(): Promise<void> {
    const statePath = swapStatePath();
    if (!existsSync(statePath)) return;

    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8")) as PathMigrateSwapState;
      if (
        state.operation !== "path-migrate" ||
        !Array.isArray(state.moves) ||
        !Array.isArray(state.archivedTargets)
      ) {
        throw new Error("invalid path-migrate swap state");
      }
      for (const move of state.moves) {
        for (const path of [move.oldPath, move.newPath, move.stagedPath, move.backupPath]) {
          assertRecoveryPathInsideStorage(path);
        }
      }
      for (const archived of state.archivedTargets) {
        assertRecoveryPathInsideStorage(archived.originalPath);
        if (archived.archivePath) assertRecoveryPathInsideStorage(archived.archivePath);
      }

      await this.rollbackSwap(state, statePath);
      if (existsSync(statePath)) {
        throw new Error("rollback could not restore every shard");
      }
      log("Recovered interrupted path migration", {
        oldHash: state.oldHash,
        newHash: state.newHash,
      });
    } catch (error) {
      throw new Error(`Failed to recover path-migrate swap ${statePath}: ${String(error)}`, {
        cause: error,
      });
    }
  }
}

export const shardPathMigrationService = new ShardPathMigrationService();
