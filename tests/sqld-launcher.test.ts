import { describe, expect, it } from "bun:test";
import {
  ensureSqldRunning,
  shouldAutoStartSqld,
  type DockerResult,
} from "../src/services/turso/sqld-launcher.js";

const ENABLED = { autoStartSqld: true, sqldUrl: "http://127.0.0.1:8080" };
const OK: DockerResult = { exitCode: 0, stdout: "", stderr: "" };

function dockerRunner(results: DockerResult[]) {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args);
      return results[index++] ?? OK;
    },
  };
}

function reachableSequence(...values: boolean[]): () => Promise<boolean> {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)];
}

const fast = { readyTimeoutMs: 0, unreachableGraceMs: 0, pollIntervalMs: 0 };

function run(args: EnsureArgs) {
  return ensureSqldRunning({ ...fast, ...args });
}

type EnsureArgs = Parameters<typeof ensureSqldRunning>[0];

describe("shouldAutoStartSqld", () => {
  it("requires both opt-in and the default loopback URL", () => {
    expect(shouldAutoStartSqld(ENABLED)).toBe(true);
    expect(shouldAutoStartSqld({ autoStartSqld: false, sqldUrl: ENABLED.sqldUrl })).toBe(false);
    expect(shouldAutoStartSqld({ autoStartSqld: true, sqldUrl: "https://db.example.com" })).toBe(
      false
    );
  });
});

describe("ensureSqldRunning", () => {
  it("does nothing when opt-in is off", async () => {
    const runner = dockerRunner([]);
    const result = await run({
      config: { autoStartSqld: false, sqldUrl: ENABLED.sqldUrl },
      reachable: reachableSequence(false),
      runDocker: runner.run,
    });
    expect(result.status).toBe("skipped");
    expect(runner.calls).toEqual([]);
  });

  it("does nothing for a custom or remote URL", async () => {
    const runner = dockerRunner([]);
    const result = await run({
      config: { autoStartSqld: true, sqldUrl: "https://db.example.com" },
      reachable: reachableSequence(false),
      runDocker: runner.run,
    });
    expect(result.status).toBe("skipped");
    expect(runner.calls).toEqual([]);
  });

  it("reuses a reachable server without touching Docker", async () => {
    const runner = dockerRunner([]);
    const result = await run({
      config: ENABLED,
      reachable: reachableSequence(true),
      runDocker: runner.run,
    });
    expect(result.status).toBe("already-running");
    expect(runner.calls).toEqual([]);
  });

  it("runs the pinned container with a named volume when none exists", async () => {
    const runner = dockerRunner([OK, { ...OK, exitCode: 1 }, OK]);
    const progress: string[] = [];
    const result = await run({
      config: ENABLED,
      reachable: reachableSequence(false, true),
      runDocker: runner.run,
      onProgress: (message) => progress.push(message),
    });
    expect(result.status).toBe("started");
    expect(runner.calls[0]).toEqual(["info"]);
    expect(runner.calls[1]).toEqual([
      "inspect",
      "--format",
      "{{.State.Running}}",
      "opencode-mem-sqld",
    ]);
    expect(runner.calls[2]).toEqual([
      "run",
      "-d",
      "--name",
      "opencode-mem-sqld",
      "-p",
      "8080:8080",
      "-v",
      "opencode-mem-sqld-data:/var/lib/sqld",
      "-e",
      "SQLD_NODE=primary",
      "ghcr.io/tursodatabase/libsql-server:latest",
    ]);
    expect(progress.join(" ")).toContain("first run may pull the image");
  });

  it("starts a stopped container instead of recreating it", async () => {
    const runner = dockerRunner([OK, { ...OK, stdout: "false" }, OK]);
    const result = await run({
      config: ENABLED,
      reachable: reachableSequence(false, true),
      runDocker: runner.run,
    });
    expect(result.status).toBe("started");
    expect(runner.calls[2]).toEqual(["start", "opencode-mem-sqld"]);
    expect(runner.calls.some((call) => call[0] === "run")).toBe(false);
  });

  it("waits for a running container that has not become ready yet", async () => {
    const runner = dockerRunner([OK, { ...OK, stdout: "true" }]);
    const result = await run({
      config: ENABLED,
      reachable: reachableSequence(false, false, true),
      runDocker: runner.run,
      unreachableGraceMs: 1000,
    });
    expect(result.status).toBe("reused");
    expect(runner.calls).toHaveLength(2);
  });

  it("refuses to recreate a running container that stays unreachable", async () => {
    const runner = dockerRunner([OK, { ...OK, stdout: "true" }]);
    await expect(
      run({
        config: ENABLED,
        reachable: reachableSequence(false),
        runDocker: runner.run,
      })
    ).rejects.toThrow("was not recreated");
    expect(runner.calls.some((call) => call[0] === "run")).toBe(false);
  });

  it("reports Docker being unavailable with the manual command", async () => {
    const runner = dockerRunner([{ exitCode: 1, stdout: "", stderr: "daemon not running" }]);
    await expect(
      run({
        config: ENABLED,
        reachable: reachableSequence(false),
        runDocker: runner.run,
      })
    ).rejects.toThrow("docker compose -f scripts/sqld-compose.yml up -d");
    expect(runner.calls).toHaveLength(1);
  });

  it("reports a failed docker start", async () => {
    const runner = dockerRunner([
      OK,
      { ...OK, stdout: "false" },
      { exitCode: 1, stdout: "", stderr: "permission denied" },
    ]);
    await expect(
      run({
        config: ENABLED,
        reachable: reachableSequence(false),
        runDocker: runner.run,
      })
    ).rejects.toThrow("permission denied");
  });

  it("reports a failed docker run", async () => {
    const runner = dockerRunner([
      OK,
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "no space left on device" },
    ]);
    await expect(
      run({
        config: ENABLED,
        reachable: reachableSequence(false),
        runDocker: runner.run,
      })
    ).rejects.toThrow("no space left on device");
  });

  it("reuses a container another process created at the same time", async () => {
    const runner = dockerRunner([
      OK,
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "Conflict. The container name is already in use" },
    ]);
    const result = await run({
      config: ENABLED,
      reachable: reachableSequence(false, true),
      runDocker: runner.run,
    });
    expect(result.status).toBe("started");
  });

  it("times out with a logs hint when sqld never becomes reachable", async () => {
    const runner = dockerRunner([OK, { exitCode: 1, stdout: "", stderr: "" }, OK]);
    await expect(
      run({
        config: ENABLED,
        reachable: reachableSequence(false),
        runDocker: runner.run,
      })
    ).rejects.toThrow("docker logs opencode-mem-sqld");
  });
});
