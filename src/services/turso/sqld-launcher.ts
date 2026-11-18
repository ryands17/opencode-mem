import { setTimeout as delay } from "node:timers/promises";
import { CONFIG } from "../../config.js";
import { DEFAULT_SQLD_URL } from "./sqld-defaults.js";
import { probeSqld } from "./sqld-probe.js";

const CONTAINER_NAME = "opencode-mem-sqld";
const VOLUME_NAME = "opencode-mem-sqld-data";
const IMAGE = "ghcr.io/tursodatabase/libsql-server:latest";
const DEFAULT_READY_TIMEOUT_MS = 10 * 60 * 1000;
const UNREACHABLE_GRACE_MS = 30 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;

const MANUAL_START = "docker compose -f scripts/sqld-compose.yml up -d";

export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LauncherConfig {
  autoStartSqld?: boolean;
  sqldUrl?: string;
}

export type SqldLaunchStatus = "skipped" | "already-running" | "started" | "reused";

export interface EnsureSqldOptions {
  config?: LauncherConfig;
  reachable?: () => Promise<boolean>;
  runDocker?: (args: string[]) => Promise<DockerResult>;
  onProgress?: (message: string) => void;
  readyTimeoutMs?: number;
  unreachableGraceMs?: number;
  pollIntervalMs?: number;
}

export function shouldAutoStartSqld(config: LauncherConfig = CONFIG): boolean {
  return config.autoStartSqld === true && config.sqldUrl === DEFAULT_SQLD_URL;
}

export async function isSqldReachable(): Promise<boolean> {
  try {
    await probeSqld();
    return true;
  } catch {
    return false;
  }
}

async function realRunDocker(args: string[]): Promise<DockerResult> {
  try {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitUntilReachable(
  reachable: () => Promise<boolean>,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await reachable()) return true;
    if (Date.now() >= deadline) return false;
    await delay(pollIntervalMs);
  }
}

export async function ensureSqldRunning(
  options: EnsureSqldOptions = {}
): Promise<{ status: SqldLaunchStatus }> {
  const config = options.config ?? CONFIG;
  if (!shouldAutoStartSqld(config)) return { status: "skipped" };

  const reachable = options.reachable ?? isSqldReachable;
  const runDocker = options.runDocker ?? realRunDocker;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const onProgress = options.onProgress;

  if (await reachable()) return { status: "already-running" };

  const info = await runDocker(["info"]);
  if (info.exitCode !== 0) {
    throw new Error(
      `autoStartSqld is enabled but Docker is unavailable: ${info.stderr || "docker info failed"}. ` +
        `Start Docker, or start sqld manually with: ${MANUAL_START}`
    );
  }

  const inspect = await runDocker(["inspect", "--format", "{{.State.Running}}", CONTAINER_NAME]);
  const containerExists = inspect.exitCode === 0;
  const containerRunning = containerExists && inspect.stdout === "true";

  if (containerRunning) {
    onProgress?.("sqld container is running but not responding yet; waiting...");
    const ready = await waitUntilReachable(
      reachable,
      options.unreachableGraceMs ?? UNREACHABLE_GRACE_MS,
      pollIntervalMs
    );
    if (!ready) {
      throw new Error(
        `sqld container ${CONTAINER_NAME} is running but unreachable at ${config.sqldUrl}. ` +
          `It was not recreated (that could lose data). Check: docker logs ${CONTAINER_NAME}`
      );
    }
    return { status: "reused" };
  }

  if (containerExists) {
    onProgress?.("Starting existing sqld container...");
    const start = await runDocker(["start", CONTAINER_NAME]);
    if (start.exitCode !== 0) {
      throw new Error(
        `Failed to start ${CONTAINER_NAME}: ${start.stderr || `docker start exited ${start.exitCode}`}`
      );
    }
  } else {
    onProgress?.("Starting local sqld (first run may pull the image)...");
    const run = await runDocker([
      "run",
      "-d",
      "--name",
      CONTAINER_NAME,
      "-p",
      "8080:8080",
      "-v",
      `${VOLUME_NAME}:/var/lib/sqld`,
      "-e",
      "SQLD_NODE=primary",
      IMAGE,
    ]);
    if (run.exitCode !== 0) {
      const detail = run.stderr || `docker run exited ${run.exitCode}`;
      if (/already in use|conflict/i.test(detail)) {
        // Another OpenCode instance created it at the same time; reuse it.
        onProgress?.("sqld container was created by another process; reusing it...");
      } else {
        throw new Error(`Failed to start local sqld: ${detail}`);
      }
    }
  }

  const ready = await waitUntilReachable(
    reachable,
    options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    pollIntervalMs
  );
  if (!ready) {
    throw new Error(
      `sqld did not become reachable at ${config.sqldUrl} within ` +
        `${Math.round((options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 1000)}s. ` +
        `Check: docker logs ${CONTAINER_NAME}. To start it manually: ${MANUAL_START}`
    );
  }
  return { status: "started" };
}
