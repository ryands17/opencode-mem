import assert from "node:assert/strict";
import { createClient } from "@libsql/client/web";

const TABLE = "ocm_phase0_vector_smoke";
const DEFAULT_URLS = ["http://127.0.0.1:8080", "ws://127.0.0.1:8080"];
const urls = (process.env.SQLD_URLS ?? DEFAULT_URLS.join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const authToken = process.env.SQLD_AUTH_TOKEN;
const timeout = process.env.SQLD_TIMEOUT_MS ? Number(process.env.SQLD_TIMEOUT_MS) : undefined;

function makeClient(url) {
  return createClient({
    url,
    ...(authToken ? { authToken } : {}),
    ...(timeout ? { timeout } : {}),
    concurrency: 1,
  });
}

function optionsDescription(url) {
  return JSON.stringify({
    url,
    authToken: authToken ? "<set>" : "<none>",
    timeout: timeout ?? "<default>",
    concurrency: 1,
    transport: "@libsql/client/web",
  });
}

async function verify(url) {
  const client = makeClient(url);
  try {
    await client.execute(`DROP TABLE IF EXISTS ${TABLE}`);
    await client.execute(`
      CREATE TABLE ${TABLE} (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        vector F32_BLOB(4) NOT NULL
      )
    `);

    const rows = [
      [1, "target", "[1,0,0,0]"],
      [2, "orthogonal", "[0,1,0,0]"],
      [3, "near", "[0.95,0.05,0,0]"],
    ];
    for (const [id, label, vector] of rows) {
      await client.execute({
        sql: `INSERT INTO ${TABLE} (id, label, vector) VALUES (?, ?, vector32(?))`,
        args: [id, label, vector],
      });
    }

    const ranked = await client.execute({
      sql: `SELECT id, label, vector_distance_cos(vector, vector32(?)) AS dist
            FROM ${TABLE} ORDER BY dist ASC LIMIT 3`,
      args: ["[1,0,0,0]"],
    });
    assert.equal(ranked.rows.length, 3, "exact scan must return all three rows");
    assert.deepEqual(
      ranked.rows.map((row) => Number(row.id)),
      [1, 3, 2],
      "rows must be ordered by cosine distance ascending"
    );
    const exactDistance = Number(ranked.rows[0].dist);
    const orthogonalDistance = Number(ranked.rows[2].dist);
    assert.ok(
      Math.abs(exactDistance) < 1e-6,
      `identical vector must have distance ~0, got ${exactDistance}`
    );
    assert.ok(
      Math.abs(orthogonalDistance - 1) < 1e-6,
      `orthogonal vector must have distance ~1, got ${orthogonalDistance}`
    );

    const windowed = await client.execute({
      sql: `SELECT id FROM ${TABLE}
            ORDER BY vector_distance_cos(vector, vector32(?)) ASC LIMIT 2 OFFSET 1`,
      args: ["[1,0,0,0]"],
    });
    assert.deepEqual(
      windowed.rows.map((row) => Number(row.id)),
      [3, 2],
      "LIMIT/OFFSET must preserve rank order"
    );

    let namedArgs = "not tested";
    try {
      const named = await client.execute({
        sql: `SELECT id FROM ${TABLE} WHERE id = :id`,
        args: { id: 1 },
      });
      namedArgs = named.rows.length === 1 ? "ok" : `unexpected rows: ${named.rows.length}`;
    } catch (error) {
      namedArgs = `unsupported: ${error.message}`;
    }

    return {
      distances: [exactDistance, orthogonalDistance],
      rankedIds: ranked.rows.map((row) => Number(row.id)),
      namedArgs,
    };
  } finally {
    client.close();
  }
}

console.log(
  `[verify-sqld-vector] runtime=${process.versions.bun ? "bun" : "node"} ` +
    `platform=${process.platform} arch=${process.arch}`
);

let requiredFailure = false;
for (const url of urls) {
  const required = url.startsWith("http");
  console.log(`[verify-sqld-vector] options=${optionsDescription(url)}`);
  try {
    const result = await verify(url);
    console.log(
      `[verify-sqld-vector] PASS ${url} distances=${result.distances.join(",")} ` +
        `ranked=${result.rankedIds.join(",")} namedArgs=${result.namedArgs}`
    );
  } catch (error) {
    console.error(`[verify-sqld-vector] FAIL ${url}: ${error?.stack ?? error}`);
    if (required) requiredFailure = true;
  }
}

if (requiredFailure) process.exit(1);
