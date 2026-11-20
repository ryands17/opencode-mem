import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { tursoConnectionManager } from "../turso/connection-manager.js";
import { TursoDb } from "../turso/turso-db.js";

/**
 * Standalone coordination tables in the shared sqld database. They are
 * deliberately separate from the memory tables: every statement here is short
 * and autonomous, and no transaction is ever held across the LLM round trip,
 * so lock traffic cannot block normal memory database work. It only stores
 * ephemeral lock rows.
 */
export const PROFILE_LEARNING_COORDINATION_DB = ".profile-learning-coordination.db";

const LOCK_NAME = "profile-learning";

interface ProcessIdentity {
  pid: number;
  bootId: string | null;
  starttime: string | null;
}

interface ValidOwner {
  ownerToken: string;
  pid: number;
  bootId: string | null;
  starttime: string | null;
  parsedStarttime: ParsedStarttime | null;
}

type ProcStatResult =
  { status: "ok"; starttime: string } | { status: "absent" } | { status: "unreadable" };

const LINUX_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DARWIN_BOOT_ID_PATTERN = /^darwin-boot-\d+$/;

function isKnownBootId(value: string): boolean {
  return LINUX_BOOT_ID_PATTERN.test(value) || DARWIN_BOOT_ID_PATTERN.test(value);
}

let cachedBootId: string | null | undefined;

function coordinationDbPath(): string {
  return resolve(CONFIG.storagePath || "", PROFILE_LEARNING_COORDINATION_DB);
}

async function withCoordinationDb<T>(fn: (db: TursoDb) => Promise<T>): Promise<T> {
  const dbPath = coordinationDbPath();
  const db = await tursoConnectionManager.getConnection(dbPath);
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS profile_learning_lock (
      name TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      pid INTEGER NOT NULL,
      boot_id TEXT,
      starttime TEXT,
      acquired_at INTEGER NOT NULL
    )`);
    return await fn(db);
  } finally {
    await tursoConnectionManager.closeConnection(dbPath);
  }
}

const LOCK_OPEN_ERROR_RE =
  /File is locked by another process|already open|Locking error|busy|SQLITE_BUSY/i;

function isCoordinationLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return LOCK_OPEN_ERROR_RE.test(message);
}

async function withCoordinationDbRetry<T>(fn: (db: TursoDb) => Promise<T>): Promise<T> {
  const attempts = 8;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await withCoordinationDb(fn);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !isCoordinationLockError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 15 + attempt * 25));
    }
  }
  throw lastError;
}

function readBootIdUncached(): string | null {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    if (LINUX_BOOT_ID_PATTERN.test(value)) return value;
  } catch {}

  if (process.platform === "darwin") {
    try {
      const result = spawnSync("sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: 2_000,
      });
      if (result.status === 0 && typeof result.stdout === "string") {
        const match = result.stdout.match(/sec\s*=\s*(\d+)/);
        if (match) {
          const bootId = `darwin-boot-${match[1]}`;
          return DARWIN_BOOT_ID_PATTERN.test(bootId) ? bootId : null;
        }
      }
    } catch {
      return null;
    }
  }

  return null;
}

function readBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  cachedBootId = readBootIdUncached();
  return cachedBootId;
}

function readLinuxProcStat(pid: number): ProcStatResult {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { status: "absent" }
      : { status: "unreadable" };
  }
  const commEnd = stat.lastIndexOf(")");
  if (commEnd === -1) {
    return { status: "unreadable" };
  }
  const fields = stat.slice(commEnd + 2).split(" ");
  const starttime = fields[22 - 3];
  return starttime && /^\d+$/.test(starttime)
    ? { status: "ok", starttime }
    : { status: "unreadable" };
}

function readDarwinStarttime(pid: number): ProcStatResult {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    if (result.status !== 0) {
      return { status: "absent" };
    }
    const lstart = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (!lstart) return { status: "absent" };
    // WARNING: store and compare the raw LC_ALL=C lstart text verbatim; normalizing it (e.g. Date.parse) makes TZ/implementation differences fire false PID-reuse steals against live holders.
    const starttime = `darwin:${lstart}`;
    if (parseStoredStarttime(starttime) === null) {
      return { status: "unreadable" };
    }
    return { status: "ok", starttime };
  } catch {
    return { status: "unreadable" };
  }
}

function readProcStat(pid: number): ProcStatResult {
  if (process.platform === "linux") {
    return readLinuxProcStat(pid);
  }
  if (process.platform === "darwin") {
    return readDarwinStarttime(pid);
  }
  return { status: "unreadable" };
}

function currentProcessIdentity(): ProcessIdentity {
  const own = readProcStat(process.pid);
  const starttime = own.status === "ok" ? own.starttime : null;
  return {
    pid: process.pid,
    bootId: readBootId(),
    starttime: starttime !== null && parseStoredStarttime(starttime) !== null ? starttime : null,
  };
}

function coercePid(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "bigint" && value > 0n && Number.isSafeInteger(Number(value))) {
    return Number(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  return null;
}

type StarttimeKind = "linux" | "darwin";

interface ParsedStarttime {
  kind: StarttimeKind;
  value: string;
}

const DARWIN_LSTART_PATTERN =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)  ?(\d{1,2}) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d (\d{4})$/;

const DARWIN_WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DARWIN_MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function isValidDarwinLstart(lstart: string): boolean {
  const match = DARWIN_LSTART_PATTERN.exec(lstart);
  if (!match) return false;
  const weekday = match[1];
  const monthIndex = DARWIN_MONTH_NAMES.indexOf(match[2] as (typeof DARWIN_MONTH_NAMES)[number]);
  const day = Number(match[3]);
  const year = Number(match[5]);
  if (year < 1) return false;
  const utc = new Date(Date.UTC(year, monthIndex, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== monthIndex ||
    utc.getUTCDate() !== day
  ) {
    return false;
  }
  return DARWIN_WEEKDAY_NAMES[utc.getUTCDay()] === weekday;
}

function parseStoredStarttime(raw: string): ParsedStarttime | null {
  if (/^\d+$/.test(raw)) return { kind: "linux", value: raw };
  if (raw.startsWith("darwin:")) {
    const lstart = raw.slice("darwin:".length);
    if (isValidDarwinLstart(lstart)) {
      return { kind: "darwin", value: lstart };
    }
  }
  return null;
}

function coerceOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

type StoredBootId = { kind: "none" } | { kind: "known"; value: string };

function parseStoredBootId(value: unknown): StoredBootId | null {
  if (value === null) return { kind: "none" };
  if (typeof value === "string" && isKnownBootId(value)) {
    return { kind: "known", value };
  }
  return null;
}

function parseOwnerRow(
  row: Record<string, unknown>
): { ok: true; owner: ValidOwner } | { ok: false; reason: string } {
  const ownerToken = coerceOptionalString(row["owner_token"]);
  if (!ownerToken) return { ok: false, reason: "owner_token missing/empty" };

  const pid = coercePid(row["pid"]);
  if (pid === null) return { ok: false, reason: `invalid pid: ${String(row["pid"])}` };

  const storedBootId = parseStoredBootId(row["boot_id"]);
  if (!storedBootId) return { ok: false, reason: `invalid boot_id: ${String(row["boot_id"])}` };
  const bootId = storedBootId.kind === "known" ? storedBootId.value : null;

  let starttime: string | null = null;
  let parsedStarttime: ParsedStarttime | null = null;
  if (row["starttime"] !== null && row["starttime"] !== undefined) {
    const raw = row["starttime"];
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 160) {
      return { ok: false, reason: "invalid starttime" };
    }
    parsedStarttime = parseStoredStarttime(raw);
    if (!parsedStarttime) {
      return { ok: false, reason: `invalid starttime: ${raw.slice(0, 40)}` };
    }
    starttime = raw;
  }

  const acquiredAt = row["acquired_at"];
  if (
    typeof acquiredAt !== "number" &&
    typeof acquiredAt !== "bigint" &&
    !/^\d+$/.test(String(acquiredAt ?? ""))
  ) {
    return { ok: false, reason: "invalid acquired_at" };
  }

  return { ok: true, owner: { ownerToken, pid, bootId, starttime, parsedStarttime } };
}

function isPidGoneBySignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

function ownerIsDefinitelyDead(owner: ValidOwner, self: ProcessIdentity): boolean {
  if (self.bootId !== null && owner.bootId !== null && owner.bootId !== self.bootId) {
    return true;
  }

  if (self.starttime !== null && owner.starttime !== null) {
    if (owner.parsedStarttime === null) {
      return false;
    }
    const selfParsed = parseStoredStarttime(self.starttime);
    if (selfParsed === null || selfParsed.kind !== owner.parsedStarttime.kind) {
      return false;
    }
    const stat = readProcStat(owner.pid);
    if (stat.status === "ok") {
      const liveParsed = parseStoredStarttime(stat.starttime);
      if (liveParsed === null || liveParsed.kind !== owner.parsedStarttime.kind) {
        return false;
      }
      return stat.starttime !== owner.starttime;
    }
    if (stat.status === "absent") {
      return isPidGoneBySignal(owner.pid);
    }
    return false;
  }

  return isPidGoneBySignal(owner.pid);
}

function releaseFn(ownerToken: string): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await withCoordinationDbRetry(async (db) => {
        await db.run(`DELETE FROM profile_learning_lock WHERE name = ? AND owner_token = ?`, [
          LOCK_NAME,
          ownerToken,
        ]);
      });
    } catch (error) {
      log("profile-learning lock: release failed; row will be reclaimed after exit", {
        error: String(error),
      });
    }
  };
}

async function casTestHooks(
  phase: "select" | "update",
  row?: Record<string, unknown> | null
): Promise<void> {
  if (process.env.PLL_CAS_HOOKS !== "1") return;
  const storage = process.env.PLL_STORAGE;
  const label = process.env.PLL_LABEL ?? "x";
  if (!storage) return;

  const { existsSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const barrier = (name: string) => join(storage, `hs.${name}`);
  const waitFile = async (path: string) => {
    const deadline = Date.now() + 30_000;
    while (!existsSync(path)) {
      if (Date.now() > deadline) throw new Error(`barrier timeout: ${path}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  if (phase === "select") {
    const token = row ? String(row["owner_token"] ?? "none") : "none";
    writeFileSync(barrier(`token.${label}`), token);
    return;
  }

  writeFileSync(barrier(`seen.${label}`), "ready");
  await waitFile(barrier("go.update"));
}

/**
 * Serializes profile learning across every process sharing this storage path.
 *
 * Ownership is a single row in a standalone SQLite coordination database:
 *  - acquiring is one `INSERT ... ON CONFLICT DO NOTHING` (rowsAffected 1 wins);
 *  - a conflicting row is only taken over with a conditional
 *    `UPDATE ... WHERE owner_token = <old token>` (CAS) when the recorded
 *    owner is provably dead or its original process identity is gone;
 *  - release is `DELETE ... WHERE owner_token = <token>`, so a stale release
 *    from a previous owner (even with a reused PID) can never drop someone
 *    else's lock.
 *
 * Returns a release function, or null when another process holds the lock or
 * the coordination state cannot be trusted (fail-closed) — in both cases the
 * caller must skip this round rather than wait, because the next idle event
 * retries.
 *
 * Service wiring note: this function is async and must be `await`ed by the
 * caller, with the in-process `isLearningRunning` guard set before the first
 * `await`.
 */
export async function tryAcquireProfileLearningLock(
  directory: string
): Promise<(() => Promise<void>) | null> {
  const identity = currentProcessIdentity();
  const ownerToken = randomUUID();

  try {
    type AcquireDecision =
      | { kind: "acquired" }
      | { kind: "skip" }
      | { kind: "cas"; oldToken: string; previousPid: number };

    const decision = await withCoordinationDbRetry(async (db): Promise<AcquireDecision> => {
      const inserted = await db.run(
        `INSERT INTO profile_learning_lock
                (name, owner_token, pid, boot_id, starttime, acquired_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (name) DO NOTHING`,
        [LOCK_NAME, ownerToken, identity.pid, identity.bootId, identity.starttime, Date.now()]
      );
      if (inserted === 1) {
        return { kind: "acquired" };
      }

      const row = await db.get(
        `SELECT owner_token, pid, boot_id, starttime, acquired_at
              FROM profile_learning_lock WHERE name = ?`,
        [LOCK_NAME]
      );
      if (!row) {
        return { kind: "skip" };
      }

      await casTestHooks("select", row);

      const parsed = parseOwnerRow(row);
      if (!parsed.ok) {
        log("profile-learning lock: malformed coordination record, refusing to acquire", {
          directory,
          reason: parsed.reason,
        });
        return { kind: "skip" };
      }

      if (!ownerIsDefinitelyDead(parsed.owner, identity)) {
        return { kind: "skip" };
      }

      return {
        kind: "cas",
        oldToken: parsed.owner.ownerToken,
        previousPid: parsed.owner.pid,
      };
    });

    if (decision.kind === "acquired") {
      return releaseFn(ownerToken);
    }
    if (decision.kind === "skip") {
      return null;
    }

    await casTestHooks("update");

    const claimed = await withCoordinationDbRetry(async (db) =>
      db.run(
        `UPDATE profile_learning_lock
              SET owner_token = ?, pid = ?, boot_id = ?, starttime = ?, acquired_at = ?
              WHERE name = ? AND owner_token = ?`,
        [
          ownerToken,
          identity.pid,
          identity.bootId,
          identity.starttime,
          Date.now(),
          LOCK_NAME,
          decision.oldToken,
        ]
      )
    );
    if (claimed === 1) {
      log("profile-learning lock: reclaimed lock from dead owner", {
        directory,
        previousPid: decision.previousPid,
      });
      return releaseFn(ownerToken);
    }
    return null;
  } catch (error) {
    log("profile-learning lock: coordination database unavailable, refusing to acquire", {
      directory,
      error: String(error),
    });
    return null;
  }
}

/**
 * Whether a coordination record currently exists. Test/inspection helper; a
 * database error is reported as "not held" but logged.
 */
export async function isProfileLearningLockHeld(): Promise<boolean> {
  try {
    return await withCoordinationDbRetry(async (db) => {
      const row = await db.get(`SELECT 1 AS ok FROM profile_learning_lock WHERE name = ? LIMIT 1`, [
        LOCK_NAME,
      ]);
      return row != null;
    });
  } catch (error) {
    log("profile-learning lock: coordination database unavailable in isProfileLearningLockHeld", {
      error: String(error),
    });
    return false;
  }
}

/** Boot identity the lock would record for this process (test/inspection helper). */
export function getProfileLearningBootId(): string | null {
  return readBootId();
}

/** Starttime identity the lock would record for `pid` (test/inspection helper). */
export function getProfileLearningStarttime(pid: number): string | null {
  const result = readProcStat(pid);
  return result.status === "ok" ? result.starttime : null;
}
