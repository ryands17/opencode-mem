import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createClient } from "@libsql/client/web";
import { TursoDb } from "../src/services/turso/turso-db.js";
import { requiredTestSqldUrl } from "./turso-test-utils.js";

const table = `sqld_adapter_test_${process.pid}_${Date.now()}`;
let db: TursoDb;

beforeAll(async () => {
  db = new TursoDb(createClient({ url: requiredTestSqldUrl(), concurrency: 1 }));
  await db.execute(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, value TEXT, count INTEGER)`);
});

afterAll(async () => {
  await db.execute(`DROP TABLE IF EXISTS ${table}`);
  db.close();
});

describe("sqld adapter", () => {
  it("binds positional arguments and reports result metadata", async () => {
    const inserted = await db.execute(`INSERT INTO ${table} (id, value, count) VALUES (?, ?, ?)`, [
      "pos",
      "hello",
      7,
    ]);
    expect(inserted.rowsAffected).toBe(1);
    expect(inserted.columns).toEqual([]);

    const row = await db.get<{ id: string; value: string; count: number }>(
      `SELECT id, value, count FROM ${table} WHERE id = ?`,
      ["pos"]
    );
    expect(row).toEqual({ id: "pos", value: "hello", count: 7 });

    const result = await db.execute(`SELECT count FROM ${table} WHERE id = ?`, ["pos"]);
    expect(result.columns).toContain("count");
    expect(result.columnTypes.length).toBeGreaterThan(0);
  });

  it("binds named arguments", async () => {
    await db.execute(`INSERT INTO ${table} (id, value, count) VALUES (:id, :value, :count)`, {
      id: "named",
      value: "world",
      count: 9,
    });
    const row = await db.get<{ value: string; count: number }>(
      `SELECT value, count FROM ${table} WHERE id = :id`,
      { id: "named" }
    );
    expect(row).toEqual({ value: "world", count: 9 });
  });

  it("runs a batch of statements in order", async () => {
    const results = await db.batch([
      { sql: `INSERT INTO ${table} (id, value) VALUES (?, ?)`, args: ["batch-1", "a"] },
      { sql: `INSERT INTO ${table} (id, value) VALUES (?, ?)`, args: ["batch-2", "b"] },
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.rowsAffected === 1)).toBe(true);

    const rows = await db.all<{ id: string }>(`SELECT id FROM ${table} WHERE id LIKE 'batch-%'`);
    expect(rows.map((row) => row.id)).toEqual(["batch-1", "batch-2"]);
  });

  it("commits a transaction and rolls back on error", async () => {
    await db.transaction("write", async (tx) => {
      await tx.run(`INSERT INTO ${table} (id, value) VALUES (?, ?)`, ["tx-ok", "committed"]);
    });
    expect(await db.get(`SELECT id FROM ${table} WHERE id = ?`, ["tx-ok"])).not.toBeNull();

    await expect(
      db.transaction("write", async (tx) => {
        await tx.run(`INSERT INTO ${table} (id, value) VALUES (?, ?)`, ["tx-bad", "rolled back"]);
        throw new Error("abort transaction");
      })
    ).rejects.toThrow("abort transaction");
    expect(await db.get(`SELECT id FROM ${table} WHERE id = ?`, ["tx-bad"])).toBeNull();
  });
});
