import { describe, expect, it } from "bun:test";
import pkg from "../package.json";

describe("published dependency constraints", () => {
  it("uses the pure-JS @libsql/client for sqld persistence", () => {
    expect(pkg.dependencies["@libsql/client"]).toBeTruthy();
  });

  it("ships no native-binding dependencies", () => {
    expect(pkg.dependencies).not.toHaveProperty("@tursodatabase/database");
    expect(pkg.dependencies).not.toHaveProperty("@huggingface/transformers");
    expect(pkg.dependencies).not.toHaveProperty("@xenova/transformers");
    expect(pkg.dependencies).not.toHaveProperty("onnxruntime-node");
    expect(pkg.dependencies).not.toHaveProperty("usearch");
    expect((pkg as { overrides?: Record<string, string> }).overrides ?? {}).not.toHaveProperty(
      "onnxruntime-node"
    );
  });
});
