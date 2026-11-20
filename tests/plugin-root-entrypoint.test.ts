import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

const rootIndex = new URL("../index.js", import.meta.url);
const distPlugin = new URL("../dist/plugin.js", import.meta.url);

describe("local checkout root entrypoint", () => {
  it("ships a root index.js that re-exports the built v2 plugin", () => {
    expect(existsSync(rootIndex)).toBe(true);
  });

  it("resolves to the same v2 plugin definition as dist/plugin.js", async () => {
    const root = await import(rootIndex.href);
    const dist = await import(distPlugin.href);
    expect(root.default).toBeDefined();
    expect(root.default.id).toBe("opencode-mem");
    expect(typeof root.default.setup).toBe("function");
    expect(typeof root.default.server).toBe("function");
    expect(root.default.id).toBe(dist.default.id);
  });
});
