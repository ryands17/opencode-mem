import { describe, expect, it } from "bun:test";
import { getEmbeddingModelPreset } from "../src/config.js";

describe("getEmbeddingModelPreset", () => {
  it("returns no forced prefixes for nomic", () => {
    expect(getEmbeddingModelPreset("Xenova/nomic-embed-text-v1")).toEqual({});
  });

  it("returns empty prefixes for bge-m3", () => {
    expect(getEmbeddingModelPreset("Xenova/bge-m3")).toEqual({
      queryPrefix: "",
      documentPrefix: "",
    });
  });

  it("returns e5 query/passage prefixes", () => {
    expect(getEmbeddingModelPreset("intfloat/multilingual-e5-large")).toEqual({
      queryPrefix: "query: ",
      documentPrefix: "passage: ",
    });
    expect(getEmbeddingModelPreset("intfloat/e5-large-v2")?.queryPrefix).toBe("query: ");
  });

  it("returns an instruct query prefix for Qwen3-Embedding", () => {
    const preset = getEmbeddingModelPreset("Qwen3-Embedding-0.6B");
    expect(preset?.documentPrefix).toBe("");
    expect(preset?.queryPrefix).toContain("Instruct:");
    expect(preset?.queryPrefix).toContain("Query: ");
  });

  it("returns empty prefixes for jina", () => {
    expect(getEmbeddingModelPreset("Xenova/jina-embeddings-v2-base-en")).toEqual({
      queryPrefix: "",
      documentPrefix: "",
    });
  });

  it("returns undefined for unknown models", () => {
    expect(getEmbeddingModelPreset("Xenova/all-MiniLM-L6-v2")).toBeUndefined();
  });
});
