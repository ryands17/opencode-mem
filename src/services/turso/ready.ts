import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@libsql/client/web";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { tursoShardManager } from "./shard-manager.js";

const HEALTH_TIMEOUT_MS = 2000;
const HEALTH_RETRY_DELAYS_MS = [100, 250, 500, 1000];

let initPromise: Promise<void> | null = null;
let isReady = false;

async function probeSqld(): Promise<void> {
  const client = createClient({
    url: CONFIG.sqldUrl,
    ...(CONFIG.sqldAuthToken ? { authToken: CONFIG.sqldAuthToken } : {}),
    concurrency: 1,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.execute("SELECT 1"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no response within ${HEALTH_TIMEOUT_MS}ms`)),
          HEALTH_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    client.close();
  }
}

async function waitForSqld(): Promise<void> {
  let lastError: unknown;
  for (const retryDelay of [0, ...HEALTH_RETRY_DELAYS_MS]) {
    if (retryDelay) await delay(retryDelay);
    try {
      await probeSqld();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `sqld is unreachable at ${CONFIG.sqldUrl}: ${message}. ` +
      `Start it with: docker compose -f scripts/sqld-compose.yml up -d`
  );
}

export async function ensureTursoReady(): Promise<void> {
  if (isReady) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await waitForSqld();
      await tursoShardManager.getAllShards("user", "");
      isReady = true;
    } catch (error) {
      initPromise = null;
      log("sqld ready gate failed", { error: String(error) });
      throw error;
    }
  })();

  return initPromise;
}

export function resetTursoReady(): void {
  isReady = false;
  initPromise = null;
}
