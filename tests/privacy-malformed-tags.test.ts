import { describe, it, expect } from "bun:test";
import { stripPrivateContent, isFullyPrivate } from "../src/services/privacy.js";

const SECRET = "sk-live-abc123";

describe("privacy: malformed <private> markup", () => {
  it("redacts to the end of input when the closing tag is missing", () => {
    const result = stripPrivateContent(`my key is <private>${SECRET}`);

    expect(result).not.toContain(SECRET);
    expect(result).toBe("my key is [REDACTED]");
  });

  it("treats an unclosed tag as fully private when nothing else remains", () => {
    expect(isFullyPrivate(`<private>${SECRET}`)).toBe(true);
  });

  it("redacts a region left unclosed by a truncated message", () => {
    const result = stripPrivateContent(`intro <private>${SECRET} and more text`);
    expect(result).not.toContain(SECRET);
    expect(result).not.toContain("and more text");
  });

  it("closes a nested region at the outer tag, not the first inner one", () => {
    const result = stripPrivateContent(
      `<private>outer <private>inner</private> ${SECRET}</private>`
    );

    expect(result).not.toContain(SECRET);
    expect(result).not.toContain("inner");
    expect(result).not.toContain("private>");
    expect(result).toBe("[REDACTED]");
  });

  it("handles whitespace inside the tag the way a parser would", () => {
    const result = stripPrivateContent(`<private >${SECRET}</private >`);

    expect(result).not.toContain(SECRET);
    expect(result).toBe("[REDACTED]");
  });

  it("drops a stray closing tag instead of surfacing it as content", () => {
    expect(stripPrivateContent("visible </private> text")).toBe("visible  text");
  });

  it("keeps mixed-case tags working, including when unclosed", () => {
    expect(stripPrivateContent(`<PRIVATE>${SECRET}</private>`)).toBe("[REDACTED]");
    expect(stripPrivateContent(`<Private>${SECRET}`)).toBe("[REDACTED]");
  });

  it("redacts each well-formed region independently and keeps the text between", () => {
    const result = stripPrivateContent(`a <private>one</private> b <private>two</private> c`);
    expect(result).toBe("a [REDACTED] b [REDACTED] c");
  });

  it("leaves content with no tags untouched, including other angle brackets", () => {
    expect(stripPrivateContent("use Array<string> and a < b")).toBe("use Array<string> and a < b");
    expect(stripPrivateContent("")).toBe("");
    expect(stripPrivateContent("no markup at all")).toBe("no markup at all");
  });

  it("is not confused by a similarly named tag", () => {
    const input = "<privateer>ship</privateer>";
    expect(stripPrivateContent(input)).toBe(input);
  });

  it("does not leak across repeated calls", () => {
    const input = `<private>${SECRET}</private>`;
    expect(stripPrivateContent(input)).toBe("[REDACTED]");
    expect(stripPrivateContent(input)).toBe("[REDACTED]");
    expect(stripPrivateContent(input)).toBe("[REDACTED]");
  });

  it("redacts an unclosed region that opens after a closed one", () => {
    const result = stripPrivateContent(`<private>first</private> middle <private>${SECRET}`);
    expect(result).not.toContain(SECRET);
    expect(result).toBe("[REDACTED] middle [REDACTED]");
  });
});
