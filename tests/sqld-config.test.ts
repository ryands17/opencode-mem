import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG, initConfig } from "../src/config.js";

const inheritedConfigDir = process.env.OPENCODE_MEM_CONFIG_DIR;

let globalConfigDir: string | undefined;

function prepareConfig(fileConfig: Record<string, unknown>): void {
  globalConfigDir = mkdtempSync(join(tmpdir(), "opencode-mem-sqld-config-"));
  process.env.OPENCODE_MEM_CONFIG_DIR = globalConfigDir;
  writeFileSync(
    join(globalConfigDir, "opencode-mem.jsonc"),
    JSON.stringify({
      embeddingApiUrl: "http://127.0.0.1:8765/v1",
      embeddingApiKey: "fixture-key",
      ...fileConfig,
    }),
    "utf-8"
  );
}

function loadConfig(fileConfig: Record<string, unknown>): void {
  prepareConfig(fileConfig);
  initConfig("/nonexistent-project");
}

afterEach(() => {
  process.env.OPENCODE_MEM_CONFIG_DIR = inheritedConfigDir!;
  if (globalConfigDir) {
    rmSync(globalConfigDir, { recursive: true, force: true });
    globalConfigDir = undefined;
  }
  initConfig("/nonexistent-project");
});

describe("sqld config", () => {
  it("defaults to the local sqld endpoint", () => {
    loadConfig({});
    expect(CONFIG.sqldUrl).toBe("http://127.0.0.1:8080");
    expect(CONFIG.sqldAuthToken).toBeUndefined();
    expect(CONFIG.autoStartSqld).toBe(false);
  });

  it("loads the autoStartSqld opt-in", () => {
    loadConfig({ autoStartSqld: true });
    expect(CONFIG.autoStartSqld).toBe(true);
  });

  it("trims trailing slashes from sqldUrl", () => {
    loadConfig({ sqldUrl: "https://db.example.com:8080///" });
    expect(CONFIG.sqldUrl).toBe("https://db.example.com:8080");
  });

  it("accepts http, https, ws, wss and libsql URLs", () => {
    for (const url of [
      "http://127.0.0.1:8080",
      "https://db.example.com",
      "ws://127.0.0.1:8080",
      "wss://db.example.com",
      "libsql://db.example.com",
    ]) {
      loadConfig({ sqldUrl: url });
      expect(CONFIG.sqldUrl).toBe(url);
    }
  });

  it("rejects an invalid sqldUrl scheme", () => {
    prepareConfig({ sqldUrl: "ftp://nope" });
    expect(() => initConfig("/nonexistent-project")).toThrow("Invalid sqldUrl config");
  });

  it("resolves a sqldAuthToken secret reference", () => {
    const previous = process.env.OPENCODE_MEM_TEST_SQLD_TOKEN;
    process.env.OPENCODE_MEM_TEST_SQLD_TOKEN = "test-token";
    try {
      loadConfig({ sqldAuthToken: "env://OPENCODE_MEM_TEST_SQLD_TOKEN" });
      expect(CONFIG.sqldAuthToken).toBe("test-token");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MEM_TEST_SQLD_TOKEN;
      else process.env.OPENCODE_MEM_TEST_SQLD_TOKEN = previous;
    }
  });
});
