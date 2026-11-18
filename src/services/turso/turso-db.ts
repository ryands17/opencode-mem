import type {
  Client,
  Config,
  InArgs,
  InStatement,
  ResultSet as LibsqlResultSet,
  Transaction,
} from "@libsql/client/web";

export type SqlValue = null | string | number | bigint | boolean | Uint8Array | ArrayBuffer;
export type SqlArgs = SqlValue[] | Record<string, SqlValue>;

export interface ResultSet {
  columns: string[];
  columnTypes: string[];
  rows: Array<Record<string, unknown>>;
  rowsAffected: number;
  lastInsertRowid?: number | bigint;
}

type Row = Record<string, unknown>;

function normalizeArgs(args?: SqlArgs): InArgs {
  return (args ?? []) as InArgs;
}

function toStatement(sql: string, args?: SqlArgs): InStatement {
  return { sql, args: normalizeArgs(args) };
}

function toResultSet(result: LibsqlResultSet): ResultSet {
  return {
    columns: result.columns ?? [],
    columnTypes: result.columnTypes ?? [],
    rows: (result.rows ?? []) as Array<Record<string, unknown>>,
    rowsAffected: Number(result.rowsAffected ?? 0),
    lastInsertRowid: result.lastInsertRowid,
  };
}

export interface TursoTx {
  execute(statement: { sql: string; args?: SqlArgs } | string, args?: SqlArgs): Promise<ResultSet>;
  run(sql: string, args?: SqlArgs): Promise<number>;
  get<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T | null>;
  all<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T[]>;
}

class TursoTxAdapter implements TursoTx {
  constructor(private readonly tx: Transaction) {}

  async execute(
    statement: { sql: string; args?: SqlArgs } | string,
    args?: SqlArgs
  ): Promise<ResultSet> {
    const sql = typeof statement === "string" ? statement : statement.sql;
    const bind = typeof statement === "string" ? args : statement.args;
    return toResultSet(await this.tx.execute(toStatement(sql, bind)));
  }

  async run(sql: string, args?: SqlArgs): Promise<number> {
    return (await this.execute(sql, args)).rowsAffected;
  }

  async get<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T | null> {
    const rows = await this.all<T>(sql, args);
    return rows[0] ?? null;
  }

  async all<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T[]> {
    return (await this.execute(sql, args)).rows as unknown as T[];
  }
}

export class TursoDb {
  constructor(private readonly client: Client) {}

  getClient(): Client {
    return this.client;
  }

  async execute(sql: string, args?: SqlArgs): Promise<ResultSet> {
    return toResultSet(await this.client.execute(toStatement(sql, args)));
  }

  async batch(
    statements: Array<{ sql: string; args?: SqlArgs }>,
    mode: "write" | "read" = "write"
  ): Promise<ResultSet[]> {
    const results = await this.client.batch(
      statements.map((statement) => toStatement(statement.sql, statement.args)),
      mode
    );
    return results.map(toResultSet);
  }

  async get<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T | null> {
    const rows = await this.all<T>(sql, args);
    return rows[0] ?? null;
  }

  async all<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T[]> {
    const result = await this.client.execute(toStatement(sql, args));
    return result.rows as unknown as T[];
  }

  async run(sql: string, args?: SqlArgs): Promise<number> {
    const result = await this.client.execute(toStatement(sql, args));
    return Number(result.rowsAffected ?? 0);
  }

  async transaction<T>(mode: "write" | "read", fn: (tx: TursoTx) => Promise<T>): Promise<T> {
    const tx = await this.client.transaction(mode);
    try {
      const result = await fn(new TursoTxAdapter(tx));
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    this.client.close();
  }

  closeSync(): void {
    this.client.close();
  }
}

export type { Client, Config };
