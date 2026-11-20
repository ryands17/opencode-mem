import { mock } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as importedFs from "node:fs";
import * as importedChildProcess from "node:child_process";
import { createClient } from "@libsql/client/web";
import { TursoDb } from "../../src/services/turso/turso-db.js";
import { requiredTestSqldUrl } from "../turso-test-utils.js";

const storage = process.env.PLL_STORAGE;
const mode = process.env.PLL_MODE;
const label = process.env.PLL_LABEL ?? "x";
const sqldUrl = process.env.PLL_SQLD_URL ?? requiredTestSqldUrl();
if (!storage || !mode) {
  console.error("PLL_STORAGE and PLL_MODE are required");
  process.exit(2);
}

const realReadFileSync = importedFs.readFileSync;
const realSpawnSync = importedChildProcess.spawnSync;

const configUrl = new URL("../../src/config.js", import.meta.url).href;
const loggerUrl = new URL("../../src/services/logger.js", import.meta.url).href;
const lockUrl = new URL("../../src/services/user-profile/learning-lock.js", import.meta.url).href;

mock.module(configUrl, () => ({
  CONFIG: { storagePath: storage, sqldUrl },
  initConfig: () => {},
  isConfigured: () => true,
}));
mock.module(loggerUrl, () => ({ log: () => {}, safeLog: () => {} }));

if (mode === "current-boot-invalid") {
  mock.module("node:fs", () => ({
    ...importedFs,
    readFileSync: (path: any, options: any) =>
      path === "/proc/sys/kernel/random/boot_id"
        ? "not-a-boot-id"
        : realReadFileSync(path, options),
  }));
  mock.module("node:child_process", () => ({
    ...importedChildProcess,
    spawnSync: (command: any, args?: any, options?: any) => {
      if (
        command === "sysctl" &&
        Array.isArray(args) &&
        args[0] === "-n" &&
        args[1] === "kern.boottime"
      ) {
        return {
          status: 0,
          stdout: "garbage-boot-identity",
          stderr: "",
          pid: 0,
          output: [],
          signal: null,
        };
      }
      return realSpawnSync(command, args, options);
    },
  }));
}
if (mode === "darwin-sim") {
  const forcedSelfLstart = process.env.PLL_STARTTIME ?? null;
  const liveGarbageForForeignPids = process.env.PLL_LABEL === "live-garbage";
  Object.defineProperty(process, "platform", { value: "darwin" });
  mock.module("node:child_process", () => ({
    ...importedChildProcess,
    spawnSync: (command: any, args?: any, options?: any) => {
      if (
        command === "ps" &&
        Array.isArray(args) &&
        args.includes("-o") &&
        args.includes("lstart=")
      ) {
        const pidIdx = args.indexOf("-p");
        const requestedPid = pidIdx >= 0 ? Number(args[pidIdx + 1]) : NaN;
        const stdout =
          liveGarbageForForeignPids && requestedPid !== process.pid
            ? "not-a-valid-lstart"
            : (forcedSelfLstart ?? "");
        return {
          status: 0,
          stdout,
          stderr: "",
          pid: 0,
          output: [],
          signal: null,
        };
      }
      if (
        command === "sysctl" &&
        Array.isArray(args) &&
        args[0] === "-n" &&
        args[1] === "kern.boottime"
      ) {
        return {
          status: 0,
          stdout: "{ sec = 1760000000, usec = 0 } Sat Oct  3 09:00:00 2026",
          stderr: "",
          pid: 0,
          identity: [],
          signal: null,
        };
      }
      return realSpawnSync(command, args, options);
    },
  }));
}
const lock = await import(lockUrl);

const barrier = (name: string) => join(storage, `hs.${name}`);
const WAIT_MS = 30_000;

async function waitFile(path: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${path}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function signal(path: string): void {
  writeFileSync(path, "ready");
}

function out(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

async function openDb(): Promise<TursoDb> {
  return new TursoDb(createClient({ url: sqldUrl, concurrency: 1 }));
}

async function readOwnerToken(): Promise<string | null> {
  const db = await openDb();
  try {
    const result = await db.execute(
      `SELECT owner_token FROM profile_learning_lock WHERE name = 'profile-learning'`
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? String(row["owner_token"]) : null;
  } finally {
    await db.close();
  }
}

async function dbExecutePlant(
  db: TursoDb,
  caseName: string,
  starttime: string | null
): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO profile_learning_lock
            (name, owner_token, pid, boot_id, starttime, acquired_at)
          VALUES ('profile-learning', ?, ?, NULL, ?, ?)`,
    [`planted-${caseName}`, process.pid, starttime, Date.now()]
  );
}

try {
  switch (mode) {
    case "hold": {
      const release = await lock.tryAcquireProfileLearningLock("/project-hold");
      if (!release) {
        out({ acquired: false });
        break;
      }
      const heldBefore = await lock.isProfileLearningLockHeld();
      signal(barrier("acquired"));
      await waitFile(barrier("release"));
      await release();
      const heldAfter = await lock.isProfileLearningLockHeld();
      out({ acquired: true, heldBefore, heldAfter });
      break;
    }

    case "try": {
      await waitFile(barrier("acquired"));
      const release = await lock.tryAcquireProfileLearningLock("/project-try");
      out({ acquired: release !== null });
      if (release) await release();
      break;
    }

    case "hold-forever": {
      const release = await lock.tryAcquireProfileLearningLock("/project-forever");
      if (!release) {
        out({ acquired: false });
        break;
      }
      signal(barrier("acquired"));
      await waitFile(barrier("never"));
      await release();
      break;
    }

    case "probe": {
      const release = await lock.tryAcquireProfileLearningLock("/project-probe");
      out({ acquired: release !== null });
      if (release) await release();
      break;
    }

    case "cas-race": {
      signal(barrier(`ready.${label}`));
      await waitFile(barrier("go"));
      const release = await lock.tryAcquireProfileLearningLock("/project-race");
      signal(barrier(`attempted.${label}`));
      out({ acquired: release !== null });
      if (release) {
        const peer = label === "a" ? "b" : "a";
        await waitFile(barrier(`attempted.${peer}`));
        await release();
      }
      break;
    }

    case "proc-probe": {
      const forced = label;
      if (forced === "EPERM" || forced === "OK" || forced === "ESRCH") {
        const realKill = process.kill.bind(process);
        process.kill = ((pid: number, signal?: number | string) => {
          if (pid === 4194304) {
            if (forced === "EPERM") {
              const e = new Error(`kill EPERM`) as NodeJS.ErrnoException;
              e.code = "EPERM";
              throw e;
            }
            if (forced === "ESRCH") {
              const e = new Error(`kill ESRCH`) as NodeJS.ErrnoException;
              e.code = "ESRCH";
              throw e;
            }
            return;
          }
          return realKill(pid, signal);
        }) as typeof process.kill;
      }
      const release = await lock.tryAcquireProfileLearningLock("/project-probe");
      out({ forced, acquired: release !== null });
      if (release) await release();
      break;
    }

    case "boot-variants": {
      const { getProfileLearningBootId, getProfileLearningStarttime } = await import(lockUrl);
      const ownStarttime = getProfileLearningStarttime(process.pid);
      const bootFile = getProfileLearningBootId();
      if (!ownStarttime || !bootFile) {
        console.error("boot-variants requires local boot + starttime identity");
        process.exit(1);
      }
      const variants: Array<{ name: string; bootId: unknown; useRawSql?: string }> = [
        { name: "validNull", bootId: null },
        { name: "invalidString", bootId: "not-a-boot-id" },
        { name: "number", bootId: 12345 },
        {
          name: "object",
          bootId: null,
          useRawSql: 'CAST(\'{"v":"x"}\' AS BLOB)',
        },
        { name: "sameAsHost", bootId: bootFile },
      ];
      const results: Record<string, boolean> = {};
      for (const v of variants) {
        const db = await openDb();
        try {
          await db.run(`CREATE TABLE IF NOT EXISTS profile_learning_lock (
            name TEXT PRIMARY KEY,
            owner_token TEXT NOT NULL,
            pid INTEGER NOT NULL,
            boot_id TEXT,
            starttime TEXT,
            acquired_at INTEGER NOT NULL
          )`);
          if (v.useRawSql !== undefined) {
            await db.run(`INSERT OR REPLACE INTO profile_learning_lock
                    (name, owner_token, pid, boot_id, starttime, acquired_at)
                  VALUES ('profile-learning', 'planted-${v.name}', ${process.pid}, ${v.useRawSql}, '${ownStarttime}', ${Date.now()})`);
          } else {
            await db.run(
              `INSERT OR REPLACE INTO profile_learning_lock
                    (name, owner_token, pid, boot_id, starttime, acquired_at)
                  VALUES ('profile-learning', 'planted-${v.name}', ?, ?, ?, ?)`,
              [process.pid, v.bootId as string | number | null, ownStarttime, Date.now()]
            );
          }
        } finally {
          await db.close();
        }
        const release = await lock.tryAcquireProfileLearningLock("/project-boot");
        results[v.name] = release !== null;
        if (release) await release();
      }
      out({ variants: results });
      break;
    }

    case "starttime-variants": {
      const cases: Array<{
        name: string;
        pid: number;
        starttime: string | null;
      }> = [
        { name: "bare-darwin-prefix", pid: 4194304, starttime: "darwin:" },
        { name: "darwin-garbage-suffix", pid: 4194304, starttime: "darwin:garbage" },
        {
          name: "darwin-malformed-lstart",
          pid: 4194304,
          starttime: "darwin:not-a-date-at-all",
        },
        {
          name: "darwin-partial-lstart",
          pid: 4194304,
          starttime: "darwin:Sat Oct 3",
        },
        {
          name: "darwin-24h-violation",
          pid: 4194304,
          starttime: "darwin:Sat Oct  3 25:61:61 2026",
        },
        { name: "empty-string", pid: 4194304, starttime: "" },
        { name: "prefix-numeric-junk", pid: 4194304, starttime: "darwin:12345" },
      ];
      const ownStarttime = lock.getProfileLearningStarttime(process.pid);
      if (ownStarttime) {
        const darwinHost = ownStarttime.startsWith("darwin:");
        const foreignLive = darwinHost ? "12345678" : "darwin:Sat Oct  3 09:00:00 2026";
        const foreignDead = darwinHost ? "87654321" : "darwin:Sun Nov 16 10:11:12 2025";
        const localDeadStarttime = darwinHost ? "darwin:Sun Nov 16 10:11:12 2025" : "12345678";
        cases.push(
          { name: "foreign-kind-live-owner", pid: process.pid, starttime: foreignLive },
          { name: "foreign-kind-dead-pid", pid: 4194304, starttime: foreignDead },
          { name: "local-kind-dead-pid-steal", pid: 4194304, starttime: localDeadStarttime },
          { name: "live-owner-real-starttime", pid: process.pid, starttime: ownStarttime },
          { name: "live-owner-null-starttime", pid: process.pid, starttime: null },
          {
            name: "same-kind-mismatch-steal",
            pid: process.pid,
            starttime: darwinHost
              ? ownStarttime.replace(/\d{2}:\d{2}:\d{2}/, (t) =>
                  t === "23:59:59" ? "00:00:00" : "23:59:59"
                )
              : ownStarttime === "1"
                ? "2"
                : "1",
          }
        );
      }
      const results: Record<string, unknown> = {};
      const tokens: Record<string, string | null> = {};
      for (const c of cases) {
        const db = await openDb();
        try {
          await db.run(`CREATE TABLE IF NOT EXISTS profile_learning_lock (
            name TEXT PRIMARY KEY,
            owner_token TEXT NOT NULL,
            pid INTEGER NOT NULL,
            boot_id TEXT,
            starttime TEXT,
            acquired_at INTEGER NOT NULL
          )`);
          await db.run(
            `INSERT OR REPLACE INTO profile_learning_lock
                    (name, owner_token, pid, boot_id, starttime, acquired_at)
                  VALUES ('profile-learning', ?, ?, NULL, ?, ?)`,
            [`planted-${c.name}`, c.pid, c.starttime, Date.now()]
          );
        } finally {
          await db.close();
        }
        const release = await lock.tryAcquireProfileLearningLock("/project-starttime");
        results[c.name] = release !== null;
        tokens[c.name] = await readOwnerToken();
        if (release) await release();
      }
      out({ variants: results, tokens });
      break;
    }

    case "darwin-sim": {
      if (process.env.PLL_LABEL === "live-garbage") {
        const ownStarttime = lock.getProfileLearningStarttime(process.pid);
        if (!ownStarttime) {
          console.error("live-garbage requires the simulated ps to yield a valid self lstart");
          process.exit(1);
        }
        let foreignPid = 1;
        try {
          process.kill(1, 0);
        } catch {
          foreignPid = process.pid === 1 ? 2 : process.pid + 1;
          try {
            process.kill(foreignPid, 0);
          } catch {}
        }
        const storedValid = "darwin:Sun Nov 16 10:11:12 2025";
        const db = await openDb();
        try {
          await db.run(`CREATE TABLE IF NOT EXISTS profile_learning_lock (
            name TEXT PRIMARY KEY,
            owner_token TEXT NOT NULL,
            pid INTEGER NOT NULL,
            boot_id TEXT,
            starttime TEXT,
            acquired_at INTEGER NOT NULL
          )`);
          await db.run(
            `INSERT OR REPLACE INTO profile_learning_lock
                    (name, owner_token, pid, boot_id, starttime, acquired_at)
                  VALUES ('profile-learning', ?, ?, NULL, ?, ?)`,
            ["planted-live-ps-garbage", foreignPid, storedValid, Date.now()]
          );
        } finally {
          await db.close();
        }
        const release = await lock.tryAcquireProfileLearningLock("/project-darwin-live-garbage");
        const token = await readOwnerToken();
        if (release) await release();
        out({
          ownStarttime,
          foreignPid,
          stolen: release !== null,
          token,
        });
        break;
      }
      const ownStarttime = lock.getProfileLearningStarttime(process.pid);
      if (!ownStarttime) {
        console.error("darwin-sim requires the simulated ps to yield a valid lstart");
        process.exit(1);
      }
      const cases: Array<{ name: string; starttime: string | null; steal?: boolean }> = [
        { name: "day-99", starttime: "darwin:Sat Oct 99 09:00:00 2026" },
        { name: "day-00", starttime: "darwin:Sat Oct  0 09:00:00 2026" },
        { name: "feb29-nonleap", starttime: "darwin:Sun Feb 29 09:00:00 2026" },
        { name: "apr31", starttime: "darwin:Thu Apr 31 09:00:00 2027" },
        { name: "mar32-rolls", starttime: "darwin:Mon Mar 32 09:00:00 2026" },
        { name: "weekday-mismatch", starttime: "darwin:Mon Oct  2 09:00:00 2026" },
        { name: "leap-dow-mismatch", starttime: "darwin:Wed Feb 29 09:00:00 2028" },
        { name: "empty", starttime: "" },
        { name: "garbage", starttime: "not-even-prefixed" },
        { name: "exact-self", starttime: ownStarttime },
        {
          name: "valid-leap-feb29-steal",
          starttime: "darwin:Tue Feb 29 09:00:00 2028",
          steal: true,
        },
        {
          name: "valid-different-date-steal",
          starttime: "darwin:Sun Nov 16 10:11:12 2025",
          steal: true,
        },
      ];
      const results: Record<string, boolean> = {};
      const tokens: Record<string, string | null> = {};
      for (const c of cases) {
        const db = await openDb();
        try {
          await db.run(`CREATE TABLE IF NOT EXISTS profile_learning_lock (
            name TEXT PRIMARY KEY,
            owner_token TEXT NOT NULL,
            pid INTEGER NOT NULL,
            boot_id TEXT,
            starttime TEXT,
            acquired_at INTEGER NOT NULL
          )`);
          await dbExecutePlant(db, c.name, c.starttime);
        } finally {
          await db.close();
        }
        const release = await lock.tryAcquireProfileLearningLock("/project-darwin-sim");
        results[c.name] = release !== null;
        tokens[c.name] = await readOwnerToken();
        if (release) await release();
      }
      out({ ownStarttime, variants: results, tokens });
      break;
    }

    case "current-boot-invalid": {
      const db = await openDb();
      try {
        await db.run(`CREATE TABLE IF NOT EXISTS profile_learning_lock (
          name TEXT PRIMARY KEY,
          owner_token TEXT NOT NULL,
          pid INTEGER NOT NULL,
          boot_id TEXT,
          starttime TEXT,
          acquired_at INTEGER NOT NULL
        )`);
        await db.run(
          `INSERT OR REPLACE INTO profile_learning_lock
                  (name, owner_token, pid, boot_id, starttime, acquired_at)
                VALUES ('profile-learning', 'planted-other-boot', ?, '11111111-2222-3333-4444-555555555555', NULL, ?)`,
          [process.pid, Date.now()]
        );
      } finally {
        await db.close();
      }
      const release = await lock.tryAcquireProfileLearningLock("/project-boot");
      out({ acquired: release !== null });
      if (release) await release();
      break;
    }

    case "stale-release": {
      const release = await lock.tryAcquireProfileLearningLock("/project-stale");
      if (!release) {
        out({ acquired: false, stillHeld: null });
        break;
      }
      const db = await openDb();
      try {
        await db.run(
          `UPDATE profile_learning_lock SET owner_token = 'simulated-new-owner-token'
                WHERE name = 'profile-learning'`
        );
      } finally {
        await db.close();
      }
      await release();
      const stillHeld = await lock.isProfileLearningLockHeld();
      out({ acquired: true, stillHeld });
      break;
    }

    case "release-twice": {
      const release = await lock.tryAcquireProfileLearningLock("/project-twice");
      if (!release) {
        out({ acquired: false });
        break;
      }
      await release();
      await release();
      out({ acquired: true, heldAfter: await lock.isProfileLearningLockHeld() });
      break;
    }

    default: {
      console.error(`unknown PLL_MODE: ${mode}`);
      process.exit(2);
    }
  }
} catch (error) {
  out({ error: String(error) });
  process.exit(1);
}
