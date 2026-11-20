import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";

const OPERATION_LOCK = ".turso-operation.lock";
const LEGACY_MIGRATION_LOCK = ".turso-migrate.lock";

/**
 * Thirty minutes of progress silence is far longer than a local 50-row insert
 * batch, shard swap, or individual embedding request. Long migrations heartbeat
 * at those boundaries, so total migration duration is not limited by this lease.
 */
export const TURSO_LOCK_STALE_MS = 30 * 60 * 1000;

interface LockState {
  id?: string;
  pid: number;
  timestamp?: string;
  operation?: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockAgeMs(identity: Stats, state: LockState | null): number | null {
  let timestamp = typeof state?.timestamp === "string" ? Date.parse(state.timestamp) : NaN;
  if (!Number.isFinite(timestamp)) {
    timestamp = identity.mtimeMs;
  }
  return Number.isFinite(timestamp) ? Date.now() - timestamp : null;
}

function sameFile(a: Pick<Stats, "dev" | "ino">, b: Pick<Stats, "dev" | "ino">): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Remove only the file inspected by the caller; cleanup must never throw. */
export function unlinkTursoLockIfUnchanged(
  path: string,
  identity: Pick<Stats, "dev" | "ino">
): boolean {
  try {
    if (!sameFile(identity, statSync(path))) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Release by acquisition identity, never merely by PID. */
export function releaseTursoLock(path: string, expectedId: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const identity = fstatSync(fd);
    const state = JSON.parse(readFileSync(fd, "utf-8")) as LockState | null;
    if (state?.id === expectedId) unlinkTursoLockIfUnchanged(path, identity);
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class TursoLockOwnershipLostError extends Error {
  override name = "TursoLockOwnershipLostError";
}

export function isTursoLockOwnershipLostError(
  error: unknown
): error is TursoLockOwnershipLostError {
  return error instanceof TursoLockOwnershipLostError;
}

/** Shared lease check for both write gating and atomic migration acquisition. */
export function readLiveTursoLock(path: string): LockState | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  const identity = fstatSync(fd);
  let state: LockState | null = null;
  let reason = "corrupt lock";
  try {
    state = JSON.parse(readFileSync(fd, "utf-8")) as LockState | null;
    if (state && Number.isInteger(state.pid) && state.pid > 0) {
      const age = lockAgeMs(identity, state);
      if (isProcessAlive(state.pid)) {
        if (age === null || age <= TURSO_LOCK_STALE_MS) return state;
        reason = "progress heartbeat expired";
      } else {
        reason = "dead PID";
      }
    }
  } catch {
  } finally {
    closeSync(fd);
  }
  const ageMs = lockAgeMs(identity, state);
  const removed = unlinkTursoLockIfUnchanged(path, identity);
  const details = {
    path,
    pid: state?.pid ?? null,
    ageMs,
    operation: state?.operation,
    reason,
    removed,
  };
  try {
    log("WARNING: Invalidating stale Turso migration lock", details);
  } catch {
    console.warn("WARNING: Invalidating stale Turso migration lock", details);
  }
  if (!removed) {
    try {
      if (!sameFile(identity, statSync(path))) return readLiveTursoLock(path);
    } catch {}
  }
  return null;
}

/** Refresh progress only while this process still owns the lease. */
export function heartbeatTursoLock(path: string, expectedId: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r+");
    const previous = readFileSync(fd, "utf-8");
    const state = JSON.parse(previous) as LockState | null;
    if (state?.id !== expectedId) throw new Error("lock owner changed");
    const updated = JSON.stringify({ ...state, timestamp: new Date().toISOString() });
    // WARNING: pad any shortened tail as JSON whitespace; an unpadded rewrite leaves a corrupt window between rewrite and truncate.
    const padding = Math.max(0, Buffer.byteLength(previous) - Buffer.byteLength(updated));
    const contents = Buffer.from(updated + " ".repeat(padding));
    writeSync(fd, contents, 0, contents.length, 0);
    const opened = fstatSync(fd);
    const current = statSync(path);
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("lock file replaced");
    }
  } catch (error) {
    throw new TursoLockOwnershipLostError(
      `Turso migration lock ownership lost at ${path}; aborting migration`,
      {
        cause: error,
      }
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function assertNoTursoMigrationInProgress(): void {
  for (const file of [OPERATION_LOCK, LEGACY_MIGRATION_LOCK]) {
    const path = join(CONFIG.storagePath, file);
    const state = readLiveTursoLock(path);
    if (state) {
      throw new Error(
        `Database migration is in progress${state.operation ? ` (${state.operation})` : ""} ` +
          `in process ${state.pid}; writes are temporarily blocked`
      );
    }
  }
}

export function acquireTursoOperationLock(
  operation: string
): (() => void) & { heartbeat: () => void } {
  assertNoTursoMigrationInProgress();
  const path = join(CONFIG.storagePath, OPERATION_LOCK);
  const id = randomUUID();
  const state: LockState = {
    id,
    pid: process.pid,
    timestamp: new Date().toISOString(),
    operation,
  };
  writeFileSync(path, JSON.stringify(state), { flag: "wx" });

  const release = () => releaseTursoLock(path, id);
  return Object.assign(release, { heartbeat: () => heartbeatTursoLock(path, id) });
}
