import { setTimeout as delay } from "node:timers/promises";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { ensureSqldRunning, shouldAutoStartSqld } from "./sqld-launcher.js";
import { probeSqld } from "./sqld-probe.js";
import { tursoShardManager } from "./shard-manager.js";

const HEALTH_RETRY_DELAYS_MS = [100, 250, 500, 1000];

let initPromise: Promise<void> | null = null;
let isReady = false;

export async function waitForSqld(
  delays: readonly number[] = [0, ...HEALTH_RETRY_DELAYS_MS]
): Promise<void> {
  let lastError: unknown;
  for (const retryDelay of delays) {
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
      if (shouldAutoStartSqld()) await ensureSqldRunning();
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
