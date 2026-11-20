import { afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_SQLD_CONTAINER = "opencode-mem-sqld-test";
const TEST_SQLD_IMAGE = "ghcr.io/tursodatabase/libsql-server:latest";
const TEST_SQLD_PORT = process.env.OPENCODE_MEM_TEST_SQLD_PORT ?? "8081";
const UNROUTABLE_SENTINEL = "http://127.0.0.1:1";
const READINESS_TIMEOUT_MS = 30_000;

function docker(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("docker", args, { encoding: "utf-8" });
}

async function waitForSqld(url: string): Promise<boolean> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

async function startTestSqld(): Promise<string | null> {
  if (docker(["version"]).status !== 0) return null;
  docker(["rm", "-f", TEST_SQLD_CONTAINER]);
  const url = `http://127.0.0.1:${TEST_SQLD_PORT}`;
  const started = docker([
    "run",
    "-d",
    "--name",
    TEST_SQLD_CONTAINER,
    "-p",
    `${TEST_SQLD_PORT}:8080`,
    "-e",
    "SQLD_NODE=primary",
    "-e",
    "SQLD_DB_PATH=test.db",
    TEST_SQLD_IMAGE,
  ]);
  if (started.status !== 0) {
    console.error(
      `[opencode-mem tests] could not start the throwaway test sqld:\n${started.stderr}`
    );
    return null;
  }
  if (!(await waitForSqld(url))) {
    console.error("[opencode-mem tests] test sqld did not become ready. Container logs:");
    console.error(docker(["logs", TEST_SQLD_CONTAINER]).stdout);
    docker(["rm", "-f", TEST_SQLD_CONTAINER]);
    return null;
  }
  return url;
}

let testSqldRemoved = false;
function removeTestSqld(): void {
  if (testSqldRemoved) return;
  testSqldRemoved = true;
  docker(["rm", "-f", TEST_SQLD_CONTAINER]);
  console.log("[opencode-mem tests] throwaway test sqld removed");
}

const configDir = mkdtempSync(join(tmpdir(), "opencode-mem-test-config-"));
const dataDir = mkdtempSync(join(tmpdir(), "opencode-mem-test-data-"));
process.env.OPENCODE_MEM_CONFIG_DIR = configDir;
process.env.OPENCODE_MEM_DATA_DIR = dataDir;

let testSqldUrl = process.env.OPENCODE_MEM_TEST_SQLD_URL;
if (!testSqldUrl) {
  const managedUrl = await startTestSqld();
  if (managedUrl) {
    testSqldUrl = managedUrl;
    process.env.OPENCODE_MEM_TEST_SQLD_URL = managedUrl;
    afterAll(() => {
      removeTestSqld();
    });
    process.on("exit", () => {
      removeTestSqld();
    });
    console.log(`[opencode-mem tests] throwaway sqld ready at ${managedUrl}`);
  } else {
    console.error(
      "[opencode-mem tests] No OPENCODE_MEM_TEST_SQLD_URL and no throwaway container could be started. " +
        "sqld-backed tests will fail fast instead of touching the default http://127.0.0.1:8080, which may be a live plugin database. " +
        "Start Docker, or start a dedicated sqld yourself and export OPENCODE_MEM_TEST_SQLD_URL."
    );
  }
}

writeFileSync(
  join(configDir, "opencode-mem.jsonc"),
  JSON.stringify({ sqldUrl: testSqldUrl ?? UNROUTABLE_SENTINEL }),
  "utf-8"
);
