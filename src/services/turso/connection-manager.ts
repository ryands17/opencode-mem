import { createClient, type Client, type Config } from "@libsql/client/web";
import { CONFIG } from "../../config.js";
import { safeLog } from "../logger.js";
import { TursoDb } from "./turso-db.js";

export type SqldConnectFactory = (url: string, opts?: Config) => Client;

function buildClientConfig(url: string): Config {
  return {
    url,
    ...(CONFIG.sqldAuthToken ? { authToken: CONFIG.sqldAuthToken } : {}),
    concurrency: 1,
  };
}

export function wrapSqldOpenError(url: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const authHint = CONFIG.sqldAuthToken ? " Check sqldAuthToken." : "";
  return new Error(
    `Failed to connect to sqld at ${url}: ${message}. ` +
      `Ensure sqld is running and sqldUrl is correct.${authHint}`,
    { cause: error }
  );
}

export class TursoConnectionManager {
  private readonly connections = new Map<string, TursoDb>();
  private readonly pending = new Map<string, Promise<TursoDb>>();
  private readonly closingConnections = new Map<string, Promise<void>>();
  private closingPromise: Promise<void> | null = null;

  constructor(
    private readonly connectFactory: SqldConnectFactory = (url, opts) =>
      createClient({ ...opts, url })
  ) {}

  async getConnection(dbPath: string): Promise<TursoDb> {
    if (this.closingPromise) {
      await this.closingPromise;
    }
    const closingConnection = this.closingConnections.get(dbPath);
    if (closingConnection) {
      await closingConnection;
    }

    const existing = this.connections.get(dbPath);
    if (existing) {
      return existing;
    }

    const inFlight = this.pending.get(dbPath);
    if (inFlight) {
      return inFlight;
    }

    const openPromise = (async (): Promise<TursoDb> => {
      let client: Client | null = null;
      try {
        client = this.connectFactory(CONFIG.sqldUrl, buildClientConfig(CONFIG.sqldUrl));
        const db = new TursoDb(client);
        await db.execute("PRAGMA foreign_keys = ON");
        this.connections.set(dbPath, db);
        return db;
      } catch (error) {
        try {
          client?.close();
        } catch {}
        throw wrapSqldOpenError(CONFIG.sqldUrl, error);
      }
    })();

    this.pending.set(dbPath, openPromise);

    try {
      return await openPromise;
    } catch (error) {
      this.connections.delete(dbPath);
      throw error;
    } finally {
      this.pending.delete(dbPath);
    }
  }

  async closeConnection(dbPath: string): Promise<void> {
    if (this.closingPromise) {
      await this.closingPromise;
    }
    const existingClose = this.closingConnections.get(dbPath);
    if (existingClose) {
      return existingClose;
    }

    const closePromise = Promise.resolve()
      .then(async () => {
        const pending = this.pending.get(dbPath);
        if (pending) {
          await Promise.allSettled([pending]);
        }

        const db = this.connections.get(dbPath);
        if (db) {
          try {
            await db.close();
          } catch (error) {
            safeLog("Error closing sqld connection", { path: dbPath, error: String(error) });
          }
          this.connections.delete(dbPath);
        }
      })
      .finally(() => {
        this.closingConnections.delete(dbPath);
      });

    this.closingConnections.set(dbPath, closePromise);
    return closePromise;
  }

  async closeAll(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;

    this.closingPromise = (async () => {
      await Promise.allSettled([...this.pending.values(), ...this.closingConnections.values()]);
      await Promise.allSettled(
        [...this.connections].map(async ([path, db]) => {
          try {
            await db.close();
          } catch (error) {
            safeLog("Error closing sqld connection", { path, error: String(error) });
          }
        })
      );
      this.connections.clear();
      this.pending.clear();
    })();

    try {
      await this.closingPromise;
    } finally {
      this.closingPromise = null;
    }
  }

  closeAllSync(): void {
    for (const [path, db] of this.connections) {
      try {
        db.closeSync();
      } catch (error) {
        safeLog("Error closing sqld connection (sync)", { path, error: String(error) });
      }
    }
    this.connections.clear();
    this.pending.clear();
  }
}

export const tursoConnectionManager = new TursoConnectionManager();
