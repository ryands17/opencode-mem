import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client/web";
import { CONFIG } from "../src/config.js";
import { TursoDb } from "../src/services/turso/turso-db.js";
import {
  getProfileLearningBootId,
  getProfileLearningStarttime,
} from "../src/services/user-profile/learning-lock.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// WARNING: keep this schema identical to the lock code's — a bare name-only CREATE TABLE here poisons a fresh coordination DB.
const LOCK_TABLE = `CREATE TABLE IF NOT EXISTS profile_learning_lock (
      name TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      pid INTEGER NOT NULL,
      boot_id TEXT,
      starttime TEXT,
      acquired_at INTEGER NOT NULL
    )`;

async function resetLockTable(): Promise<void> {
  await withDb("", async (db) => {
    await db.run(LOCK_TABLE);
    await db.run(`DELETE FROM profile_learning_lock`);
  });
}

beforeAll(async () => {
  await resetLockTable();
});

afterEach(async () => {
  await resetLockTable();
});

const WORKER = join(import.meta.dir, "fixtures", "profile-learning-lock-worker.mts");
const LOCAL_BOOT_ID = getProfileLearningBootId();
const LOCAL_START_TIME = getProfileLearningStarttime(process.pid);
const HAS_BOOT_IDENTITY = LOCAL_BOOT_ID !== null;
const HAS_START_IDENTITY = LOCAL_START_TIME !== null;

function storage(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-learning-lock-"));
  tempDirs.push(dir);
  return dir;
}

function barrierPath(dir: string, name: string): string {
  return join(dir, `hs.${name}`);
}

async function waitBarrier(dir: string, name: string, timeoutMs = 30_000): Promise<void> {
  const path = barrierPath(dir, name);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${path}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface WorkerResult {
  exitCode: number | null;
  stderr: string;
  parsed: Record<string, unknown> | null;
}

interface WorkerProc {
  result: Promise<WorkerResult>;
  kill: (signal?: number | string) => void;
  exited: Promise<number>;
}

function spawnWorker(
  dir: string,
  mode: string,
  label = "x",
  extraEnv: Record<string, string> = {}
): WorkerProc {
  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER],
    env: {
      ...process.env,
      PLL_STORAGE: dir,
      PLL_MODE: mode,
      PLL_LABEL: label,
      ...(mode === "cas-race" ? { PLL_CAS_HOOKS: "1" } : {}),
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = (async (): Promise<WorkerResult> => {
    const stdout = (await new Response(proc.stdout).text()).trim();
    const stderr = (await new Response(proc.stderr).text()).trim();
    const exitCode = await proc.exited;
    let parsed: Record<string, unknown> | null = null;
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last) {
      try {
        parsed = JSON.parse(last) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    return { exitCode, stderr, parsed };
  })();
  return {
    result,
    kill: (signal?: number | string) => proc.kill(signal ?? ("SIGKILL" as const)),
    exited: proc.exited,
  };
}

async function runProbe(dir: string): Promise<WorkerResult> {
  const worker = spawnWorker(dir, "probe");
  return worker.result;
}

async function withDb<T>(_dir: string, fn: (db: TursoDb) => Promise<T>): Promise<T> {
  const db = new TursoDb(
    createClient({
      url: CONFIG.sqldUrl,
      ...(CONFIG.sqldAuthToken ? { authToken: CONFIG.sqldAuthToken } : {}),
      concurrency: 1,
    })
  );
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

interface PlantedOwner {
  ownerToken?: string;
  pid: number;
  bootId?: string | null;
  starttime?: string | null;
  acquiredAt?: number;
}

async function plantOwner(dir: string, owner: PlantedOwner): Promise<void> {
  await withDb(dir, async (db) => {
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
            VALUES ('profile-learning', ?, ?, ?, ?, ?)`,
      [
        owner.ownerToken ?? "planted-owner-token",
        owner.pid,
        owner.bootId ?? null,
        owner.starttime ?? null,
        owner.acquiredAt ?? Date.now(),
      ]
    );
  });
}

function readBootId(): string {
  if (!LOCAL_BOOT_ID) {
    throw new Error("no local boot identity on this platform");
  }
  return LOCAL_BOOT_ID;
}

function readStarttime(pid: number): string {
  const starttime = getProfileLearningStarttime(pid);
  if (!starttime) {
    throw new Error(`no starttime identity for pid ${pid} on this platform`);
  }
  return starttime;
}

function localKindMismatchStarttime(): string {
  if (LOCAL_START_TIME?.startsWith("darwin:")) {
    return "darwin:Sun Nov 16 10:11:12 2025";
  }
  return "1";
}

function localKindDeadPidStarttime(): string {
  if (LOCAL_START_TIME?.startsWith("darwin:")) {
    return "darwin:Sun Nov 16 10:11:12 2025";
  }
  return "12345678";
}

async function currentOwnerToken(dir: string): Promise<string | null> {
  return withDb(dir, async (db) => {
    const row = await db.get(
      `SELECT owner_token FROM profile_learning_lock WHERE name = 'profile-learning'`
    );
    return row ? String(row["owner_token"]) : null;
  });
}

describe("cross-process profile learning lock (SQL coordination DB)", () => {
  it("grants the lock to exactly one process and release frees it for the next", async () => {
    const dir = storage();

    const winner = spawnWorker(dir, "hold");
    await waitBarrier(dir, "acquired");

    const loser = spawnWorker(dir, "try");
    const loserResult = await loser.result;
    expect(loserResult.exitCode).toBe(0);
    expect(loserResult.parsed).toEqual({ acquired: false });

    writeFileSync(barrierPath(dir, "release"), "ready");
    const winnerResult = await winner.result;
    expect(winnerResult.exitCode).toBe(0);
    expect(winnerResult.parsed).toEqual({ acquired: true, heldBefore: true, heldAfter: false });

    const again = await runProbe(dir);
    expect(again.parsed).toEqual({ acquired: true });
  });

  it("release is idempotent", async () => {
    const dir = storage();
    const result = await spawnWorker(dir, "release-twice").result;
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: true, heldAfter: false });
  });

  it("never steals a live lock, even held past 30 minutes", async () => {
    const dir = storage();
    await plantOwner(dir, {
      pid: process.pid,
      bootId: HAS_BOOT_IDENTITY ? readBootId() : null,
      starttime: HAS_START_IDENTITY ? readStarttime(process.pid) : null,
      acquiredAt: Date.now() - 31 * 60 * 1000,
    });

    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: false });
    expect(await currentOwnerToken(dir)).toBe("planted-owner-token");
  });

  it.skipIf(process.platform === "win32")(
    "never steals a lock owned by a process we cannot signal (EPERM)",
    async () => {
      const dir = storage();
      await plantOwner(dir, { pid: 1, starttime: null, acquiredAt: Date.now() });

      const result = await runProbe(dir);
      expect(result.exitCode).toBe(0);
      expect(result.parsed).toEqual({ acquired: false });
      expect(await currentOwnerToken(dir)).toBe("planted-owner-token");
    }
  );

  it("exactly one of two competitors CAS-reclaims the same dead owner", async () => {
    const dir = storage();
    await plantOwner(dir, { pid: 4194304, acquiredAt: Date.now() });

    const a = spawnWorker(dir, "cas-race", "a");
    const b = spawnWorker(dir, "cas-race", "b");
    await waitBarrier(dir, "ready.a");
    await waitBarrier(dir, "ready.b");
    writeFileSync(barrierPath(dir, "go"), "ready");

    try {
      await waitBarrier(dir, "seen.a");
      await waitBarrier(dir, "seen.b");
    } catch (error) {
      const [ra, rb] = await Promise.all([a.result, b.result]);
      throw new Error(
        `${String(error)}\n` +
          `a: exit=${ra.exitCode} out=${JSON.stringify(ra.parsed)} err=${ra.stderr}\n` +
          `b: exit=${rb.exitCode} out=${JSON.stringify(rb.parsed)} err=${rb.stderr}\n` +
          `barriers=${readdirSync(dir)
            .filter((name) => name.startsWith("hs."))
            .sort()
            .join(",")}`,
        { cause: error }
      );
    }
    const tokenA = readFileSync(barrierPath(dir, "token.a"), "utf-8");
    const tokenB = readFileSync(barrierPath(dir, "token.b"), "utf-8");
    expect(tokenA).toBe(tokenB);
    expect(tokenA).toBe("planted-owner-token");
    writeFileSync(barrierPath(dir, "go.update"), "ready");

    const [ra, rb] = await Promise.all([a.result, b.result]);
    expect(ra.exitCode).toBe(0);
    expect(rb.exitCode).toBe(0);
    const acquired = [ra.parsed?.["acquired"], rb.parsed?.["acquired"]].filter(Boolean);
    expect(acquired).toHaveLength(1);
    expect(await currentOwnerToken(dir)).toBeNull();
  });

  it("a stale release cannot drop a new owner's row, even with the same PID", async () => {
    const dir = storage();
    const result = await spawnWorker(dir, "stale-release").result;
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: true, stillHeld: true });
    expect(await currentOwnerToken(dir)).toBe("simulated-new-owner-token");
  });

  it("recovers the lock after the holder is SIGKILLed without releasing", async () => {
    const dir = storage();
    const holder = spawnWorker(dir, "hold-forever");
    await waitBarrier(dir, "acquired");

    holder.kill("SIGKILL");
    await holder.exited;

    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: true });
  });

  it("reclaims a live PID only when the startup identity differs (PID reuse)", async () => {
    if (!HAS_START_IDENTITY) return;

    const dir = storage();
    await plantOwner(dir, {
      pid: process.pid,
      bootId: HAS_BOOT_IDENTITY ? readBootId() : null,
      starttime: localKindMismatchStarttime(),
      acquiredAt: Date.now(),
    });

    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: true });
    expect(await currentOwnerToken(dir)).toBeNull();
  });

  it("reclaims an owner from a previous boot even though its PID is alive now", async () => {
    if (!HAS_BOOT_IDENTITY) return;

    const dir = storage();
    await plantOwner(dir, {
      pid: process.pid,
      bootId: "00000000-0000-0000-0000-000000000000",
      starttime: HAS_START_IDENTITY ? readStarttime(process.pid) : null,
      acquiredAt: Date.now(),
    });

    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: true });
  });

  it("fails closed on malformed coordination state", async () => {
    const dir = storage();
    await plantOwner(dir, { pid: 0, acquiredAt: Date.now() });

    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: false });
    expect(await currentOwnerToken(dir)).toBe("planted-owner-token");
  });

  it("proc ENOENT alone never kills; only the kill probe decides", async () => {
    const outcomes: Record<string, boolean> = {};
    for (const forced of ["EPERM", "OK", "ESRCH"] as const) {
      const caseDir = storage();
      await plantOwner(caseDir, {
        pid: 4194304,
        starttime: localKindDeadPidStarttime(),
        acquiredAt: Date.now(),
      });
      const worker = spawnWorker(caseDir, "proc-probe", forced);
      const result = await worker.result;
      expect(result.exitCode).toBe(0);
      expect(result.parsed).toEqual({ forced, acquired: forced === "ESRCH" });
      outcomes[forced] = Boolean(result.parsed?.["acquired"]);
    }
    expect(outcomes).toEqual({ EPERM: false, OK: false, ESRCH: true });
  });

  it("boot_id variants: malformed fails closed; valid-null and same-as-host stay live", async () => {
    if (!HAS_BOOT_IDENTITY || !HAS_START_IDENTITY) return;

    const dir = storage();
    const result = await spawnWorker(dir, "boot-variants").result;
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.["variants"]).toEqual({
      validNull: false,
      invalidString: false,
      number: false,
      object: false,
      sameAsHost: false,
    });
  });

  it("stored starttime identity: strict format, cross-kind never kills, only same-kind mismatch reclaims", async () => {
    const dir = storage();
    const result = await spawnWorker(dir, "starttime-variants").result;
    expect(result.exitCode).toBe(0);
    const variants = result.parsed?.["variants"] as Record<string, boolean>;
    const tokens = result.parsed?.["tokens"] as Record<string, string | null>;

    for (const name of [
      "bare-darwin-prefix",
      "darwin-garbage-suffix",
      "darwin-malformed-lstart",
      "darwin-partial-lstart",
      "darwin-24h-violation",
      "empty-string",
      "prefix-numeric-junk",
    ]) {
      expect(variants[name]).toBe(false);
      expect(tokens[name]).toBe(`planted-${name}`);
    }

    if ("live-owner-real-starttime" in variants) {
      expect(variants["foreign-kind-live-owner"]).toBe(false);
      expect(tokens["foreign-kind-live-owner"]).toBe("planted-foreign-kind-live-owner");
      expect(variants["foreign-kind-dead-pid"]).toBe(false);
      expect(tokens["foreign-kind-dead-pid"]).toBe("planted-foreign-kind-dead-pid");
      expect(variants["local-kind-dead-pid-steal"]).toBe(true);
      expect(variants["live-owner-real-starttime"]).toBe(false);
      expect(tokens["live-owner-real-starttime"]).toBe("planted-live-owner-real-starttime");
      expect(variants["live-owner-null-starttime"]).toBe(false);
      expect(tokens["live-owner-null-starttime"]).toBe("planted-live-owner-null-starttime");
      expect(variants["same-kind-mismatch-steal"]).toBe(true);
    }
  });

  it.skipIf(process.platform === "win32")(
    "same-kind Darwin starttime: impossible dates fail closed, real dates stay usable (simulated darwin host)",
    async () => {
      const dir = storage();
      const worker = spawnWorker(dir, "darwin-sim", "self-lstart", {
        PLL_STARTTIME: "Sat Oct  3 09:00:00 2026",
      });
      const result = await worker.result;
      expect([result.exitCode, result.stderr]).toEqual([0, ""]);
      const own = result.parsed?.["ownStarttime"];
      expect(own).toBe("darwin:Sat Oct  3 09:00:00 2026");
      const variants = result.parsed?.["variants"] as Record<string, boolean>;
      const tokens = result.parsed?.["tokens"] as Record<string, string | null>;

      for (const name of [
        "day-99",
        "day-00",
        "feb29-nonleap",
        "apr31",
        "mar32-rolls",
        "weekday-mismatch",
        "leap-dow-mismatch",
        "empty",
        "garbage",
      ]) {
        expect(variants[name]).toBe(false);
        expect(tokens[name]).toBe(`planted-${name}`);
      }

      expect(variants["exact-self"]).toBe(false);
      expect(tokens["exact-self"]).toBe("planted-exact-self");
      expect(variants["valid-leap-feb29-steal"]).toBe(true);
      expect(variants["valid-different-date-steal"]).toBe(true);
    }
  );

  it.skipIf(process.platform === "win32")(
    "live Darwin ps garbage against a valid stored identity must not steal (simulated)",
    async () => {
      const dir = storage();
      const worker = spawnWorker(dir, "darwin-sim", "live-garbage", {
        PLL_STARTTIME: "Sat Oct  3 09:00:00 2026",
      });
      const result = await worker.result;
      expect([result.exitCode, result.stderr]).toEqual([0, ""]);
      expect(result.parsed?.["ownStarttime"]).toBe("darwin:Sat Oct  3 09:00:00 2026");
      expect(result.parsed?.["stolen"]).toBe(false);
      expect(result.parsed?.["token"]).toBe("planted-live-ps-garbage");
    }
  );

  it("an untrusted local boot_id never acts as a dead signal", async () => {
    if (!HAS_BOOT_IDENTITY) return;

    const dir = storage();
    const result = await spawnWorker(dir, "current-boot-invalid").result;
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: false });
  });

  it("fails closed when the coordination database cannot be opened", async () => {
    const dir = storage();
    const result = await spawnWorker(dir, "probe", "x", {
      PLL_SQLD_URL: "http://127.0.0.1:1",
    }).result;
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: false });
  });
});
