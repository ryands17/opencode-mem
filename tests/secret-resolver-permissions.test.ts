import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSecretValue } from "../src/services/secret-resolver.js";

describe("secret file permission warnings", () => {
  const SECRET = "sk-super-secret-value";
  let warnSpy: ReturnType<typeof spyOn> | undefined;
  let secretDirs: string[] = [];

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    for (const dir of secretDirs) rmSync(dir, { recursive: true, force: true });
    secretDirs = [];
  });

  function arrange(mode: number): string {
    warnSpy?.mockRestore();
    const dir = mkdtempSync(join(tmpdir(), "secret-resolver-"));
    secretDirs.push(dir);
    const file = join(dir, "secret");
    writeFileSync(file, `${SECRET}\n`);
    chmodSync(file, 0o100000 | mode);
    warnSpy = spyOn(console, "warn");
    return `file://${file}`;
  }

  const warnings = () =>
    (warnSpy?.mock.calls ?? []).map((call) => call.map(String).join(" ")).join("\n");

  const warned = () => warnings().includes("permissive permissions");

  const resolveOrThrow =
    (value: string, opts?: { platform?: NodeJS.Platform }) => (mode: number) => {
      if ((mode & 0o400) !== 0) {
        expect(resolveSecretValue(value, opts)).toBe(SECRET);
      } else {
        expect(() => resolveSecretValue(value, opts)).toThrow(/Failed to read secret file/);
      }
    };

  const SAFE_MODES = [0o600, 0o400, 0o200, 0o700, 0o000];

  const EXPOSED_MODES = [0o644, 0o640, 0o604, 0o606, 0o404, 0o060, 0o006, 0o007, 0o077, 0o777];

  it.each(SAFE_MODES)("does not warn for owner-only mode %s", (mode) => {
    const value = arrange(mode);
    resolveOrThrow(value)(mode);
    expect(warned()).toBe(false);
  });

  it.each(EXPOSED_MODES)("warns for group/other-accessible mode %s", (mode) => {
    const value = arrange(mode);
    resolveOrThrow(value)(mode);
    expect(warned()).toBe(true);
  });

  it("warns for a world-readable file that sorts below the old threshold", () => {
    const exposedValue = arrange(0o404);
    resolveSecretValue(exposedValue);
    const exposed = warned();

    const lessExposedValue = arrange(0o640);
    resolveSecretValue(lessExposedValue);
    const lessExposed = warned();

    expect(exposed).toBe(true);
    expect(lessExposed).toBe(true);
  });

  it("reports the mode in octal, zero-padded", () => {
    const value = arrange(0o006);
    expect(() => resolveSecretValue(value)).toThrow(/Failed to read secret file/);
    expect(warnings()).toContain("(006)");
  });

  it("still skips the check entirely on win32", () => {
    const value = arrange(0o777, "win32");
    expect(resolveSecretValue(value, { platform: "win32" })).toBe(SECRET);
    expect(warned()).toBe(false);
  });

  it("returns the secret regardless of the warning", () => {
    const value = arrange(0o777);
    expect(resolveSecretValue(value)).toBe(SECRET);
    expect(warned()).toBe(true);
  });
});
