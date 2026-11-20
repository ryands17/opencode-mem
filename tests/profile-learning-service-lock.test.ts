import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// WARNING: use import.meta.dir, not URL.pathname — on Windows the pathname keeps a leading slash (/D:/...) that Bun.spawn cannot execute.
const WORKER = join(import.meta.dir, "fixtures", "profile-learning-service-worker.mjs");
const MEMORY_WRITER = join(import.meta.dir, "fixtures", "profile-learning-memory-writer.mjs");

interface WorkerEvent {
  ev: string;
  data: any;
}

interface WorkerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  events: WorkerEvent[];
  eventsFile: string;
}

function readEvents(path: string): WorkerEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as WorkerEvent);
}

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let spawnSeq = 0;

function spawnWorker(
  dir: string,
  name: string,
  cfg: Record<string, unknown>
): { done: Promise<WorkerResult>; eventsFile: string } {
  const workerName = `${name}-${++spawnSeq}`;
  const eventsFile = join(dir, `events-${workerName}.ndjson`);
  const cfgPath = join(dir, `worker-${name}.json`);
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, eventsFile }));
  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER, cfgPath],
    stdout: "pipe",
    stderr: "pipe",
    // WARNING: keep HOME/XDG isolated — a child resolving a path outside CONFIG.storagePath could otherwise write the real ~/.opencode-mem.
    env: { ...process.env, HOME: dir, XDG_DATA_HOME: join(dir, "xdg-data") },
  });
  const done = (async (): Promise<WorkerResult> => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return {
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      events: readEvents(eventsFile),
      eventsFile,
    };
  })();
  return { done, eventsFile };
}

async function runScenario(
  scenario: string,
  overrides: Record<string, unknown> = {},
  dir?: string
): Promise<WorkerResult & { dir: string }> {
  const base = dir ?? tmpDir("opencode-mem-service-lock-");
  const { done } = spawnWorker(base, "solo", { scenario, storagePath: base, ...overrides });
  const r = await done;
  return { ...r, dir: base };
}

function countEv(r: { events: WorkerEvent[] }, ev: string): number {
  return r.events.filter((e) => e.ev === ev).length;
}

function findLog(r: { events: WorkerEvent[] }, needle: string): WorkerEvent | undefined {
  return r.events.find((e) => e.ev === "log" && String(e.data?.label ?? "").includes(needle));
}

async function waitForEvent(eventsFile: string, ev: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readEvents(eventsFile).some((e) => e.ev === ev)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

function runFixture(
  fixturePath: string,
  dir: string,
  name: string,
  cfg: Record<string, unknown>
): {
  done: Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  eventsFile: string;
} {
  const eventsFile = join(dir, `events-${name}.ndjson`);
  const cfgPath = join(dir, `${name}.json`);
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, eventsFile }));
  const proc = Bun.spawn({
    cmd: [process.execPath, fixturePath, cfgPath],
    stdout: "pipe",
    stderr: "pipe",
    // WARNING: keep HOME/XDG isolated — a child resolving a path outside CONFIG.storagePath could otherwise write the real ~/.opencode-mem.
    env: { ...process.env, HOME: dir, XDG_DATA_HOME: join(dir, "xdg-data") },
  });
  const done = (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  })();
  return { done, eventsFile };
}

describe("performUserProfileLearning cross-process service lock", () => {
  it("serializes two real learning runs: loser touches no SELECT/LLM/write/mark", async () => {
    const dir = tmpDir("opencode-mem-service-lock-2p-");
    const releaseFile = join(dir, "release");

    const winner = spawnWorker(dir, "winner", {
      scenario: "full",
      storagePath: dir,
      blockOnLlm: true,
      releaseFile,
    });

    expect(await waitForEvent(winner.eventsFile, "llm-entered")).toBe(true);

    const loser = spawnWorker(dir, "loser", { scenario: "full", storagePath: dir });
    const loserResult = await loser.done;

    writeFileSync(releaseFile, "go");
    const winnerResult = await winner.done;

    expect(winnerResult.exitCode).toBe(0);
    expect(loserResult.exitCode).toBe(0);
    expect(loserResult.stderr).toBe("");
    expect(winnerResult.stderr).toBe("");

    expect(findLog(loserResult, "another process holds")).toBeDefined();
    expect(countEv(loserResult, "count")).toBe(0);
    expect(countEv(loserResult, "select")).toBe(0);
    expect(countEv(loserResult, "llm-entered")).toBe(0);
    expect(countEv(loserResult, "profile-write")).toBe(0);
    expect(countEv(loserResult, "mark")).toBe(0);

    const all = [...winnerResult.events, ...loserResult.events];
    const total = (ev: string) => all.filter((e) => e.ev === ev).length;
    expect(total("llm-entered")).toBe(1);
    expect(total("llm-exit")).toBe(1);
    expect(total("profile-write")).toBe(1);
    expect(total("mark")).toBe(1);
  });

  it("releases the lock on the below-threshold early return", async () => {
    const dir = tmpDir("opencode-mem-service-lock-th-");
    const r1 = await runScenario("early", { threshold: 100, promptCount: 10 }, dir);
    expect(r1.exitCode).toBe(0);
    expect(r1.stderr).toBe("");
    expect(countEv(r1, "count")).toBe(1);
    expect(countEv(r1, "llm-entered")).toBe(0);

    const r2 = await runScenario("full", {}, dir);
    expect(r2.exitCode).toBe(0);
    expect(findLog(r2, "another process holds")).toBeUndefined();
    expect(countEv(r2, "count")).toBe(1);
    expect(countEv(r2, "llm-entered")).toBe(1);
  });

  it("releases the lock when the prompt batch comes back empty", async () => {
    const dir = tmpDir("opencode-mem-service-lock-empty-");
    const r1 = await runScenario("empty", { selectEmpty: true }, dir);
    expect(r1.exitCode).toBe(0);
    expect(r1.stderr).toBe("");
    expect(countEv(r1, "count")).toBe(1);
    expect(countEv(r1, "select")).toBe(1);
    expect(countEv(r1, "llm-entered")).toBe(0);
    expect(countEv(r1, "mark")).toBe(0);

    const r2 = await runScenario("full", {}, dir);
    expect(r2.exitCode).toBe(0);
    expect(findLog(r2, "another process holds")).toBeUndefined();
    expect(countEv(r2, "llm-entered")).toBe(1);
  });

  it("releases the lock when the provider is not ready", async () => {
    const dir = tmpDir("opencode-mem-service-lock-nr-");
    const r1 = await runScenario("not-ready", { providerReady: false }, dir);
    expect(r1.exitCode).toBe(0);
    expect(r1.stderr).toBe("");
    expect(findLog(r1, "provider not ready")).toBeDefined();
    expect(countEv(r1, "count")).toBe(0);

    const r2 = await runScenario("full", {}, dir);
    expect(r2.exitCode).toBe(0);
    expect(countEv(r2, "llm-entered")).toBe(1);
  });

  it("propagates a provider LLM error and the lock is acquirable again", async () => {
    const dir = tmpDir("opencode-mem-service-lock-err-");
    const r1 = await runScenario("llm-error", { llmError: true }, dir);
    expect(r1.exitCode).toBe(0);
    expect(r1.stderr).toBe("");
    const out = JSON.parse(r1.stdout);
    expect(out.propagated).toBe(true);
    expect(out.error).toContain("provider rejected");
    expect(countEv(r1, "llm-entered")).toBe(1);
    expect(countEv(r1, "mark")).toBe(0);

    const r2 = await runScenario("full", {}, dir);
    expect(r2.exitCode).toBe(0);
    expect(findLog(r2, "another process holds")).toBeUndefined();
    expect(countEv(r2, "llm-entered")).toBe(1);
    expect(countEv(r2, "mark")).toBe(1);
  });

  it("runs once when the same process calls concurrently (flag set before first await)", async () => {
    const r = await runScenario("inproc-race");
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.statuses).toEqual(["fulfilled", "fulfilled"]);
    expect(countEv(r, "count")).toBe(1);
    expect(countEv(r, "llm-entered")).toBe(1);
    expect(countEv(r, "mark")).toBe(1);
  });

  it("recovers the in-process flag after a failed run and succeeds on retry", async () => {
    const r = await runScenario("error-then-retry");
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.firstError).toContain("provider rejected");
    expect(countEv(r, "llm-entered")).toBe(2);
    expect(countEv(r, "llm-error")).toBe(1);
    expect(countEv(r, "mark")).toBe(1);
    expect(countEv(r, "profile-write")).toBe(1);
  });

  it("ordinary memory writes complete while profile learning holds its lock", async () => {
    const dir = tmpDir("opencode-mem-service-lock-mem-");
    const releaseFile = join(dir, "release");
    const holdingFile = join(dir, "holding");

    const winner = spawnWorker(dir, "winner", {
      scenario: "full",
      storagePath: dir,
      blockOnLlm: true,
      releaseFile,
    });
    expect(await waitForEvent(winner.eventsFile, "llm-entered")).toBe(true);
    writeFileSync(holdingFile, "held");

    const writer = runFixture(MEMORY_WRITER, dir, "memory-writer", {
      storagePath: dir,
      holdingFile,
      marker: "during-learning-lock",
    });
    const w = await writer.done;

    writeFileSync(releaseFile, "go");
    const winnerResult = await winner.done;

    expect(winnerResult.exitCode).toBe(0);
    expect(w.exitCode).toBe(0);
    expect(w.stderr).toBe("");
    const out = JSON.parse(w.stdout);
    expect(out.holdingObserved).toBe(true);
    expect(out.counts).toEqual({ add: 1, readback: 1, search: 1, list: 1 });
    expect(typeof out.addedId).toBe("string");
    expect(out.searchTotal).toBe(1);
    const winnerEvents = readEvents(winner.eventsFile);
    expect(winnerEvents.filter((e) => e.ev === "llm-entered")).toHaveLength(1);
    expect(winnerEvents.filter((e) => e.ev === "mark")).toHaveLength(1);
  });
});
