import { mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { requiredTestSqldUrl } from "../turso-test-utils.js";

const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error("usage: bun profile-learning-memory-writer.mjs <config.json>");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

const DIM = cfg.embeddingDim ?? 8;

function fixedVector(text) {
  const v = Array.from({ length: DIM });
  let h = 2166136261;
  for (const c of text) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  for (let i = 0; i < DIM; i++) {
    h ^= h << 13;
    h ^= h >>> 7;
    h ^= h << 17;
    v[i] = (((h >>> 0) % 2000) - 1000) / 1000;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return new Float32Array(v.map((x) => x / norm));
}

mock.module(new URL("../../src/services/embedding.js", import.meta.url).href, () => ({
  embeddingService: {
    embedWithTimeout: async (text) => fixedVector(text ?? ""),
    warmup: async () => {},
    isWarmedUp: true,
    initError: null,
  },
}));

const configUrl = new URL("../../src/config.js", import.meta.url).href;
mock.module(configUrl, () => ({
  CONFIG: {
    storagePath: cfg.storagePath,
    sqldUrl: cfg.sqldUrl ?? requiredTestSqldUrl(),
    maxMemories: 100,
    similarityThreshold: 0.0,
    memoryDbShardSize: 1000,
    embeddingDimensions: DIM,
    embeddingModel: "mock-fixed-vector",
    maxVectorsPerShard: 1000,
  },
  initConfig: () => {},
  isConfigured: () => true,
}));

const loggerUrl = new URL("../../src/services/logger.js", import.meta.url).href;
mock.module(loggerUrl, () => ({
  log: () => {},
  safeLog: () => {},
  serializeError: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
}));

const counts = { add: 0, readback: 0, search: 0, list: 0 };
let addedId = null;

async function waitFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !existsSync(path)) {
    await sleep(20);
  }
  if (!existsSync(path)) throw new Error(`writer: handshake file never appeared: ${path}`);
}

try {
  const { memoryClient } = await import(
    new URL("../../src/services/client.js", import.meta.url).href
  );

  if (cfg.holdingFile) await waitFile(cfg.holdingFile);

  const content = `ordinary memory ${cfg.marker ?? "writer"} ${Date.now()}`;
  const containerTag = `opencode_project_${cfg.projectHash ?? "0123456789abcdef"}`;

  const add = await memoryClient.addMemory(content, containerTag, {
    type: "preference",
    source: "manual",
    tags: ["service-lock-test"],
    projectPath: cfg.projectPath ?? "/workspace",
  });
  if (add?.success) counts.add += 1;
  addedId = add?.id ?? null;
  const search = await memoryClient.searchMemories(content, containerTag, "project");
  if (search?.success) counts.search += 1;
  if (search?.success && search.results?.some((r) => r.id === addedId)) counts.readback += 1;

  const list = await memoryClient.listMemories(containerTag, 50, "project");
  if (list?.success && list.memories?.some((m) => m.id === addedId)) counts.list += 1;

  console.log(
    JSON.stringify({
      ok: true,
      holdingObserved: Boolean(cfg.holdingFile),
      addedId,
      addError: add?.success ? undefined : (add?.error ?? "no id"),
      counts,
      searchTotal: search?.total ?? null,
    })
  );
} catch (e) {
  console.log(JSON.stringify({ fatal: e?.message ?? String(e), counts }));
  process.exit(1);
}
process.exit(0);
