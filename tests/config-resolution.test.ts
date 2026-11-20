import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryProviderConfig } from "../src/services/ai/provider-config.js";
import { applySafeExtraParams } from "../src/services/ai/providers/base-provider.js";
import {
  initConfig,
  CONFIG,
  normalizeOpencodeTimeoutMs,
  outerStructuredOutputTimeoutMs,
  OPENCODE_TIMEOUT_MS_DEFAULT,
} from "../src/config.js";
import { MEMORY_PROVIDER_PRESET_DEFAULTS } from "../src/services/ai/memory-provider-presets.js";

const inheritedConfigDir = process.env.OPENCODE_MEM_CONFIG_DIR;

describe("project-scoped config resolution", () => {
  let globalConfigDir: string;
  let projectDir: string;

  const writeGlobalConfig = (content: unknown) => {
    writeFileSync(
      join(globalConfigDir, "opencode-mem.jsonc"),
      typeof content === "string" ? content : JSON.stringify(content),
      "utf-8"
    );
  };

  const writeProjectConfig = (content: unknown) => {
    mkdirSync(join(projectDir, ".opencode"), { recursive: true });
    writeFileSync(
      join(projectDir, ".opencode", "opencode-mem.jsonc"),
      typeof content === "string" ? content : JSON.stringify(content),
      "utf-8"
    );
  };

  beforeEach(() => {
    globalConfigDir = mkdtempSync(join(tmpdir(), "opencode-mem-global-config-"));
    projectDir = mkdtempSync(join(tmpdir(), "opencode-mem-project-"));
    process.env.OPENCODE_MEM_CONFIG_DIR = globalConfigDir;
  });

  afterEach(() => {
    process.env.OPENCODE_MEM_CONFIG_DIR = inheritedConfigDir!;
    rmSync(globalConfigDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    initConfig("/nonexistent-project");
  });

  it("uses global config when no project config exists", () => {
    writeGlobalConfig({ opencodeModel: "global-model" });
    initConfig(projectDir);
    expect(CONFIG.opencodeModel).toBe("global-model");
  });

  it("project config overrides global config", () => {
    writeGlobalConfig({
      opencodeProvider: "anthropic",
      opencodeModel: "global-model",
    });
    writeProjectConfig({
      opencodeProvider: "openai",
      opencodeModel: "project-model",
    });
    initConfig(projectDir);
    expect(CONFIG.opencodeProvider).toBe("openai");
    expect(CONFIG.opencodeModel).toBe("project-model");
  });

  it("preserves JSONC string values through configuration loading and provider parameters", () => {
    writeGlobalConfig(`{
      "storagePath": "/tmp/cache,]v2",
      "memoryModel": "local-model",
      "memoryApiUrl": "https://example.invalid/v1",
      "memoryApiKey": "fixture-only-key",
      "memoryExtraParams": {"stop": [",}", ",]",],},
    }`);

    initConfig(projectDir);

    expect(CONFIG.storagePath).toBe("/tmp/cache,]v2");
    expect(CONFIG.memoryExtraParams).toEqual({ stop: [",}", ",]"] });
    const providerConfig = buildMemoryProviderConfig(CONFIG);
    const requestBody: Record<string, unknown> = {};
    applySafeExtraParams(requestBody, providerConfig.extraParams ?? {});
    expect(requestBody.stop).toEqual([",}", ",]"]);
  });

  it("keeps automatic cleanup policy under global configuration", () => {
    writeGlobalConfig({
      opencodeModel: "global-model",
      autoCleanupEnabled: false,
      autoCleanupRetentionDays: 90,
    });
    writeProjectConfig({
      opencodeModel: "project-model",
      autoCleanupEnabled: true,
      autoCleanupRetentionDays: 0,
    });

    initConfig(projectDir);

    expect(CONFIG.opencodeModel).toBe("project-model");
    expect(CONFIG.autoCleanupEnabled).toBe(false);
    expect(CONFIG.autoCleanupRetentionDays).toBe(90);
  });

  it("uses safe cleanup defaults when only project cleanup settings exist", () => {
    writeProjectConfig({
      autoCleanupEnabled: true,
      autoCleanupRetentionDays: -1,
    });

    initConfig(projectDir);

    expect(CONFIG.autoCleanupEnabled).toBe(true);
    expect(CONFIG.autoCleanupRetentionDays).toBe(30);
  });

  it("rejects project embedding transport settings before they can inherit secrets", () => {
    const oldOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-secret";
    writeGlobalConfig({ embeddingModel: "global-model" });
    writeProjectConfig({
      embeddingApiUrl: "https://attacker.example/v1",
    });

    try {
      expect(() => initConfig(projectDir)).toThrow(
        "Project config cannot set remote provider fields: embeddingApiUrl"
      );
    } finally {
      if (oldOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenAiKey;
    }
  });

  it("rejects project memory provider settings before they can reuse a global key", () => {
    writeGlobalConfig({ memoryApiKey: "global-secret" });
    writeProjectConfig({
      memoryProvider: "orcarouter",
      memoryApiUrl: "https://attacker.example/v1",
    });

    expect(() => initConfig(projectDir)).toThrow(
      "Project config cannot set remote provider fields: memoryProvider, memoryApiUrl"
    );
  });

  it("keeps global remote providers and ordinary project overrides working", () => {
    const oldEmbeddingKey = process.env.TEST_EMBEDDING_KEY;
    const oldMemoryKey = process.env.TEST_MEMORY_KEY;
    process.env.TEST_EMBEDDING_KEY = "global-embedding-secret";
    process.env.TEST_MEMORY_KEY = "global-memory-secret";
    writeGlobalConfig({
      embeddingApiUrl: "https://trusted-embeddings.example/v1",
      embeddingApiKey: "env://TEST_EMBEDDING_KEY",
      memoryProvider: "openai-chat",
      memoryApiUrl: "https://trusted-memory.example/v1",
      memoryApiKey: "env://TEST_MEMORY_KEY",
    });
    writeProjectConfig({ opencodeModel: "project-model" });

    try {
      initConfig(projectDir);
      expect(CONFIG.opencodeModel).toBe("project-model");
      expect(CONFIG.embeddingApiUrl).toBe("https://trusted-embeddings.example/v1");
      expect(CONFIG.embeddingApiKey).toBe("global-embedding-secret");
      expect(CONFIG.memoryProvider).toBe("openai-chat");
      expect(CONFIG.memoryApiUrl).toBe("https://trusted-memory.example/v1");
      expect(CONFIG.memoryApiKey).toBe("global-memory-secret");
    } finally {
      if (oldEmbeddingKey === undefined) delete process.env.TEST_EMBEDDING_KEY;
      else process.env.TEST_EMBEDDING_KEY = oldEmbeddingKey;
      if (oldMemoryKey === undefined) delete process.env.TEST_MEMORY_KEY;
      else process.env.TEST_MEMORY_KEY = oldMemoryKey;
    }
  });

  it("shallow merge: project adds fields, global fields preserved when not overridden", () => {
    writeGlobalConfig({ opencodeModel: "claude-haiku", autoCaptureEnabled: false });
    writeProjectConfig({ opencodeProvider: "anthropic" });
    initConfig(projectDir);
    expect(CONFIG.opencodeProvider).toBe("anthropic");
    expect(CONFIG.opencodeModel).toBe("claude-haiku");
    expect(CONFIG.autoCaptureEnabled).toBe(false);
  });

  it("parses opencodeVariant when set and treats blank values as unset", () => {
    writeGlobalConfig({
      opencodeProvider: "newapi",
      opencodeModel: "grok-4.7",
      opencodeVariant: "xhigh",
    });
    initConfig(projectDir);
    expect(CONFIG.opencodeVariant).toBe("xhigh");

    writeGlobalConfig({
      opencodeProvider: "newapi",
      opencodeModel: "grok-4.7",
      opencodeVariant: "   ",
    });
    initConfig(projectDir);
    expect(CONFIG.opencodeVariant).toBeUndefined();

    writeGlobalConfig({
      opencodeProvider: "newapi",
      opencodeModel: "grok-4.7",
    });
    initConfig(projectDir);
    expect(CONFIG.opencodeVariant).toBeUndefined();
  });

  it("parses opencodeTimeoutMs with clamping and default fallback", () => {
    writeGlobalConfig({ opencodeTimeoutMs: 180000 });
    initConfig(projectDir);
    expect(CONFIG.opencodeTimeoutMs).toBe(180000);

    writeGlobalConfig({ opencodeTimeoutMs: 500 });
    initConfig(projectDir);
    expect(CONFIG.opencodeTimeoutMs).toBe(10000);

    writeGlobalConfig({ opencodeTimeoutMs: 9_999_999 });
    initConfig(projectDir);
    expect(CONFIG.opencodeTimeoutMs).toBe(600000);

    writeGlobalConfig({ opencodeTimeoutMs: Number.POSITIVE_INFINITY });
    initConfig(projectDir);
    expect(CONFIG.opencodeTimeoutMs).toBe(90000);

    writeGlobalConfig({ opencodeTimeoutMs: "180000" });
    initConfig(projectDir);
    expect(CONFIG.opencodeTimeoutMs).toBe(180000);

    writeGlobalConfig({});
    initConfig(projectDir);
    expect(CONFIG.opencodeTimeoutMs).toBe(90000);
  });

  it("parses autoCaptureProviderOrder with default fallback", () => {
    writeGlobalConfig({ autoCaptureProviderOrder: "external-first" });
    initConfig(projectDir);
    expect(CONFIG.autoCaptureProviderOrder).toBe("external-first");

    writeGlobalConfig({ autoCaptureProviderOrder: "opencode-first" });
    initConfig(projectDir);
    expect(CONFIG.autoCaptureProviderOrder).toBe("opencode-first");

    writeGlobalConfig({ autoCaptureProviderOrder: "bogus" });
    initConfig(projectDir);
    expect(CONFIG.autoCaptureProviderOrder).toBe("opencode-first");

    writeGlobalConfig({});
    initConfig(projectDir);
    expect(CONFIG.autoCaptureProviderOrder).toBe("opencode-first");
  });

  it("parses chatMessage.captureChildSessions from the global config", () => {
    writeGlobalConfig({
      chatMessage: { captureChildSessions: true },
    });
    initConfig(projectDir);
    expect(CONFIG.chatMessage.captureChildSessions).toBe(true);

    writeGlobalConfig({ chatMessage: {} });
    initConfig(projectDir);
    expect(CONFIG.chatMessage.captureChildSessions).toBe(false);
  });

  it("falls back to defaults when neither global nor project config exists", () => {
    initConfig(projectDir);
    expect(CONFIG.autoCaptureEnabled).toBe(true);
    expect(CONFIG.opencodeProvider).toBeUndefined();
  });

  it("resolves Atlas Cloud API key from ATLASCLOUD_API_KEY and marks manual ready", () => {
    const originalApiKey = process.env.ATLASCLOUD_API_KEY;
    process.env.ATLASCLOUD_API_KEY = "atlas-test-key";

    try {
      writeGlobalConfig({ memoryProvider: "atlas-cloud" });
      writeProjectConfig({ autoCaptureEnabled: true });

      initConfig(projectDir);

      expect(CONFIG.memoryProvider).toBe("atlas-cloud");
      expect(CONFIG.memoryModel).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS["atlas-cloud"].model);
      expect(CONFIG.memoryApiUrl).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS["atlas-cloud"].apiUrl);
      expect(CONFIG.memoryApiKey).toBe("atlas-test-key");
      expect(CONFIG.autoCaptureProviderStatus).toEqual({
        ready: true,
        mode: "manual",
        issues: [],
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.ATLASCLOUD_API_KEY;
      } else {
        process.env.ATLASCLOUD_API_KEY = originalApiKey;
      }
    }
  });

  it("refuses a project config that switches memoryProvider to Atlas Cloud", () => {
    writeGlobalConfig({
      memoryProvider: "openai-chat",
      memoryModel: "gpt-global",
      memoryApiUrl: "https://api.openai.com/v1",
      memoryApiKey: "global-openai-secret",
    });
    writeProjectConfig({ memoryProvider: "atlas-cloud" });

    expect(() => initConfig(projectDir)).toThrow(
      /Project config cannot set remote provider fields: memoryProvider/
    );
  });

  it("resolves Cheaper Inference API key from CHEAPER_INFERENCE_API_KEY and marks manual ready", () => {
    const originalApiKey = process.env.CHEAPER_INFERENCE_API_KEY;
    process.env.CHEAPER_INFERENCE_API_KEY = "ci-test-key";

    try {
      writeGlobalConfig({ memoryProvider: "cheaper-inference" });
      writeProjectConfig({ autoCaptureEnabled: true });

      initConfig(projectDir);

      expect(CONFIG.memoryProvider).toBe("cheaper-inference");
      expect(CONFIG.memoryModel).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS["cheaper-inference"].model);
      expect(CONFIG.memoryApiUrl).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS["cheaper-inference"].apiUrl);
      expect(CONFIG.memoryApiKey).toBe("ci-test-key");
      expect(CONFIG.autoCaptureProviderStatus).toEqual({
        ready: true,
        mode: "manual",
        issues: [],
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.CHEAPER_INFERENCE_API_KEY;
      } else {
        process.env.CHEAPER_INFERENCE_API_KEY = originalApiKey;
      }
    }
  });

  it("refuses a project config that switches memoryProvider to Cheaper Inference", () => {
    writeGlobalConfig({
      memoryProvider: "openai-chat",
      memoryModel: "gpt-global",
      memoryApiUrl: "https://api.openai.com/v1",
      memoryApiKey: "global-openai-secret",
    });
    writeProjectConfig({ memoryProvider: "cheaper-inference" });

    expect(() => initConfig(projectDir)).toThrow(
      /Project config cannot set remote provider fields: memoryProvider/
    );
  });

  it("resolves API Route API key from API_ROUTE_API_KEY and marks manual ready", () => {
    const originalApiKey = process.env.API_ROUTE_API_KEY;
    process.env.API_ROUTE_API_KEY = "route-test-key";

    try {
      writeGlobalConfig({ memoryProvider: "api-route" });
      writeProjectConfig({ autoCaptureEnabled: true });

      initConfig(projectDir);

      expect(CONFIG.memoryProvider).toBe("api-route");
      expect(CONFIG.memoryModel).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS["api-route"].model);
      expect(CONFIG.memoryApiUrl).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS["api-route"].apiUrl);
      expect(CONFIG.memoryApiKey).toBe("route-test-key");
      expect(CONFIG.autoCaptureProviderStatus).toEqual({
        ready: true,
        mode: "manual",
        issues: [],
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.API_ROUTE_API_KEY;
      } else {
        process.env.API_ROUTE_API_KEY = originalApiKey;
      }
    }
  });

  it("refuses a project config that switches memoryProvider to API Route", () => {
    writeGlobalConfig({
      memoryProvider: "openai-chat",
      memoryModel: "gpt-global",
      memoryApiUrl: "https://api.openai.com/v1",
      memoryApiKey: "global-openai-secret",
    });
    writeProjectConfig({ memoryProvider: "api-route" });

    expect(() => initConfig(projectDir)).toThrow(
      /Project config cannot set remote provider fields: memoryProvider/
    );
  });

  it("resolves Runcrate API key from RUNCRATE_API_KEY and marks manual ready", () => {
    const originalApiKey = process.env.RUNCRATE_API_KEY;
    process.env.RUNCRATE_API_KEY = "runcrate-test-key";

    try {
      writeGlobalConfig({ memoryProvider: "runcrate" });
      writeProjectConfig({ autoCaptureEnabled: true });

      initConfig(projectDir);

      expect(CONFIG.memoryProvider).toBe("runcrate");
      expect(CONFIG.memoryModel).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS.runcrate.model);
      expect(CONFIG.memoryApiUrl).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS.runcrate.apiUrl);
      expect(CONFIG.memoryApiKey).toBe("runcrate-test-key");
      expect(CONFIG.autoCaptureProviderStatus).toEqual({
        ready: true,
        mode: "manual",
        issues: [],
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.RUNCRATE_API_KEY;
      } else {
        process.env.RUNCRATE_API_KEY = originalApiKey;
      }
    }
  });

  it("refuses a project config that switches memoryProvider to Runcrate", () => {
    writeGlobalConfig({
      memoryProvider: "openai-chat",
      memoryModel: "gpt-global",
      memoryApiUrl: "https://api.openai.com/v1",
      memoryApiKey: "global-openai-secret",
    });
    writeProjectConfig({ memoryProvider: "runcrate" });

    expect(() => initConfig(projectDir)).toThrow(
      /Project config cannot set remote provider fields: memoryProvider/
    );
  });
  it("resolves CloudGPU API key from CLOUDGPU_API_KEY and marks manual ready", () => {
    const originalApiKey = process.env.CLOUDGPU_API_KEY;
    process.env.CLOUDGPU_API_KEY = "cloudgpu-test-key";

    try {
      writeGlobalConfig({ memoryProvider: "cloudgpu" });
      writeProjectConfig({ autoCaptureEnabled: true });

      initConfig(projectDir);

      expect(CONFIG.memoryProvider).toBe("cloudgpu");
      expect(CONFIG.memoryModel).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS.cloudgpu.model);
      expect(CONFIG.memoryApiUrl).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS.cloudgpu.apiUrl);
      expect(CONFIG.memoryApiKey).toBe("cloudgpu-test-key");
      expect(CONFIG.autoCaptureProviderStatus).toEqual({
        ready: true,
        mode: "manual",
        issues: [],
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.CLOUDGPU_API_KEY;
      } else {
        process.env.CLOUDGPU_API_KEY = originalApiKey;
      }
    }
  });

  it("refuses a project config that switches memoryProvider to CloudGPU", () => {
    writeGlobalConfig({
      memoryProvider: "openai-chat",
      memoryModel: "global-model",
      memoryApiUrl: "https://llm.example.com/v1",
      memoryApiKey: "global-secret",
    });
    writeProjectConfig({ memoryProvider: "cloudgpu" });

    expect(() => initConfig(projectDir)).toThrow(
      /Project config cannot set remote provider fields: memoryProvider/
    );
  });

  it("resolves Standard Compute API key from STANDARDCOMPUTE_API_KEY and marks manual ready", () => {
    const originalApiKey = process.env.STANDARDCOMPUTE_API_KEY;
    process.env.STANDARDCOMPUTE_API_KEY = "standardcompute-test-key";

    try {
      writeGlobalConfig({ memoryProvider: "standardcompute" });
      writeProjectConfig({ autoCaptureEnabled: true });

      initConfig(projectDir);

      expect(CONFIG.memoryProvider).toBe("standardcompute");
      expect(CONFIG.memoryModel).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS.standardcompute.model);
      expect(CONFIG.memoryApiUrl).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS.standardcompute.apiUrl);
      expect(CONFIG.memoryApiKey).toBe("standardcompute-test-key");
      expect(Boolean(CONFIG.memoryModel && CONFIG.memoryApiUrl)).toBe(true);
      expect(CONFIG.autoCaptureProviderStatus).toEqual({
        ready: true,
        mode: "manual",
        issues: [],
      });
      const providerConfig = buildMemoryProviderConfig(CONFIG);
      expect(providerConfig.model).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS.standardcompute.model);
      expect(providerConfig.apiUrl).toBe(MEMORY_PROVIDER_PRESET_DEFAULTS.standardcompute.apiUrl);
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.STANDARDCOMPUTE_API_KEY;
      } else {
        process.env.STANDARDCOMPUTE_API_KEY = originalApiKey;
      }
    }
  });

  it("refuses a project config that switches memoryProvider to Standard Compute", () => {
    writeGlobalConfig({
      memoryProvider: "openai-chat",
      memoryModel: "global-model",
      memoryApiUrl: "https://llm.example.com/v1",
      memoryApiKey: "global-secret",
    });
    writeProjectConfig({ memoryProvider: "standardcompute" });

    expect(() => initConfig(projectDir)).toThrow(
      /Project config cannot set remote provider fields: memoryProvider/
    );
  });
});

describe("structured-output timeout derivation", () => {
  it("outer race = configured + 30000 so the inner timeout always fires first", () => {
    expect(outerStructuredOutputTimeoutMs(90_000)).toBe(120_000);
    expect(outerStructuredOutputTimeoutMs(180_000)).toBe(210_000);
    expect(outerStructuredOutputTimeoutMs(undefined)).toBe(OPENCODE_TIMEOUT_MS_DEFAULT + 30_000);
  });

  it("normalizeOpencodeTimeoutMs clamps and falls back to the default", () => {
    expect(normalizeOpencodeTimeoutMs(90_000)).toBe(90_000);
    expect(normalizeOpencodeTimeoutMs(5_000)).toBe(10_000);
    expect(normalizeOpencodeTimeoutMs(1_000_000)).toBe(600_000);
    expect(normalizeOpencodeTimeoutMs(undefined)).toBe(OPENCODE_TIMEOUT_MS_DEFAULT);
    expect(normalizeOpencodeTimeoutMs(Number.NaN)).toBe(OPENCODE_TIMEOUT_MS_DEFAULT);
    expect(normalizeOpencodeTimeoutMs(Number.POSITIVE_INFINITY)).toBe(OPENCODE_TIMEOUT_MS_DEFAULT);
    expect(normalizeOpencodeTimeoutMs("180000")).toBe(180_000);
    expect(normalizeOpencodeTimeoutMs(" 240000 ")).toBe(240_000);
    expect(normalizeOpencodeTimeoutMs("abc")).toBe(OPENCODE_TIMEOUT_MS_DEFAULT);
    expect(normalizeOpencodeTimeoutMs("")).toBe(OPENCODE_TIMEOUT_MS_DEFAULT);
  });
});
