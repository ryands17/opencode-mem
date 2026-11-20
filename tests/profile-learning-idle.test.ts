import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

const indexUrl = new URL("../src/index.js", import.meta.url).href;
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/services/tags.js", import.meta.url).href;
const contextUrl = new URL("../src/services/context.js", import.meta.url).href;
const privacyUrl = new URL("../src/services/privacy.js", import.meta.url).href;
const autoCaptureUrl = new URL("../src/services/auto-capture.js", import.meta.url).href;
const learningUrl = new URL("../src/services/user-memory-learning.js", import.meta.url).href;
const cleanupUrl = new URL("../src/services/cleanup-service.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const webServerUrl = new URL("../src/services/web-server.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const languageUrl = new URL("../src/services/language-detector.js", import.meta.url).href;
const tursoReadyUrl = new URL("../src/services/turso/ready.js", import.meta.url).href;

function runIdleScenario(opts: {
  owner?: boolean;
  webServerEnabled?: boolean;
  internalSession?: boolean;
  autoCaptureEnabled?: boolean;
}) {
  const owner = opts.owner ?? false;
  const webServerEnabled = opts.webServerEnabled ?? true;
  const internalSession = opts.internalSession ?? false;
  const autoCaptureEnabled = opts.autoCaptureEnabled ?? true;

  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-profile-idle-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

const calls = [];

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    warmup: async () => {},
    isReady: async () => true,
    close() {},
  },
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureEnabled: ${autoCaptureEnabled},
    compaction: { enabled: false, memoryLimit: 10 },
    chatMessage: { enabled: false },
    webServerEnabled: ${webServerEnabled},
    storagePath: ${JSON.stringify(dir)},
    autoCaptureProviderStatus: { ready: true, issues: [] },
  },
  initConfig: () => {},
  isConfigured: () => true,
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({ project: { tag: "project-tag" }, user: { userEmail: "u@example.com" } }),
}));
mock.module(${JSON.stringify(contextUrl)}, () => ({ formatContextForPrompt: () => "" }));
mock.module(${JSON.stringify(privacyUrl)}, () => ({
  stripPrivateContent: (value) => value,
  sanitizeMemoryContent: (value) => value,
  sanitizeMemoryField: (_key, value) => value,
  isFullyPrivate: () => false,
}));
mock.module(${JSON.stringify(promptManagerUrl)}, () => ({ userPromptManager: { savePrompt() {} } }));
mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {}, safeLog: () => {}, serializeError: (error) => ({ error: error instanceof Error ? error.message : String(error) }) }));
mock.module(${JSON.stringify(languageUrl)}, () => ({ getLanguageName: () => "English" }));
// The web server only starts once the Turso readiness gate passes, and that
// gate is what decides whether an owner exists at all.
mock.module(${JSON.stringify(tursoReadyUrl)}, () => ({ ensureTursoReady: async () => {} }));
// The internal-capture check lives inside src/index.ts and resolves the session
// title through the client, so drive it the real way: report the reserved title.
const INTERNAL_TITLE = "opencode-mem capture";

mock.module(${JSON.stringify(autoCaptureUrl)}, () => ({
  performAutoCapture: async () => { calls.push("capture"); },
  awaitCaptureDrain: async () => {},
}));
mock.module(${JSON.stringify(learningUrl)}, () => ({
  performUserProfileLearning: async () => { calls.push("learn"); },
}));
mock.module(${JSON.stringify(cleanupUrl)}, () => ({
  cleanupService: {
    shouldRunCleanup: async () => true,
    runCleanup: async () => { calls.push("cleanup"); },
  },
}));

mock.module(${JSON.stringify(webServerUrl)}, () => ({
  startWebServer: async () => (${webServerEnabled}
    ? {
        isServerOwner: () => ${owner},
        getUrl: () => "http://127.0.0.1:4747",
        setOnTakeoverCallback: () => {},
        stop: async () => {},
      }
    : null),
  WebServer: class {},
}));

// ---- deterministic 10s idle-debounce harness (installed before plugin import) ----
const armed = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, delay, ...rest) => {
  const h = realSetTimeout(fn, delay, ...rest);
  if (delay === 10000) armed.push({ handle: h, fn });
  return h;
};
const fireIdleDebounce = async () => {
  const live = armed.splice(0);
  for (const t of live) { clearTimeout(t.handle); await t.fn(); }
};

const mockClient = {
  session: {
    get: async () => ({ data: ${internalSession} ? { title: INTERNAL_TITLE } : { title: "regular work" } }),
    messages: async () => ({ data: [] }),
  },
  tui: { showToast: async () => ({}) },
};

const { OpenCodeMemPlugin } = await import(${JSON.stringify(indexUrl)});
const plugin = await OpenCodeMemPlugin({ directory: "/active-project", client: mockClient });

// Let the plugin's async web-server bootstrap settle before the idle event, so
// ownership is resolved the same way it is at runtime.
await new Promise((resolve) => setTimeout(resolve, 50));

await plugin.event({
  event: { type: "session.idle", properties: { sessionID: "user-session" } },
});

// Fire the handler's debounced idle work now instead of waiting out the 10s timer.
await fireIdleDebounce();

console.log(JSON.stringify({ calls }));
`;

  writeFileSync(scriptPath, script);
  const result = Bun.spawnSync({
    env: { ...process.env },
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  return {
    exitCode: result.exitCode,
    stderr: Buffer.from(result.stderr).toString("utf8").trim(),
    calls: stdout ? (JSON.parse(stdout).calls as string[]) : null,
  };
}

describe("profile learning trigger on session.idle", () => {
  it("learns from an active instance that does not own the web server", () => {
    const result = runIdleScenario({ owner: false });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).toEqual(["capture", "learn"]);
  });

  it("learns when the web server is disabled entirely", () => {
    const result = runIdleScenario({ webServerEnabled: false });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).toEqual(["capture", "learn"]);
  });

  it("keeps retention cleanup owner-only", () => {
    const result = runIdleScenario({ owner: true });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).toEqual(["capture", "learn", "cleanup"]);
  });

  it("runs no cleanup on a non-owner", () => {
    const result = runIdleScenario({ owner: false });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).not.toContain("cleanup");
  });

  it("skips the plugin's own internal capture sessions", () => {
    const result = runIdleScenario({ internalSession: true });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).toEqual([]);
  });

  it("does nothing when auto-capture is disabled", () => {
    const result = runIdleScenario({ autoCaptureEnabled: false });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).toEqual([]);
  });
});
