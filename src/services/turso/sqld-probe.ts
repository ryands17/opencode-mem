import { createClient } from "@libsql/client/web";
import { CONFIG } from "../../config.js";

const HEALTH_TIMEOUT_MS = 2000;

export async function probeSqld(): Promise<void> {
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
