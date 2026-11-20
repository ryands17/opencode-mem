import { describe, expect, it } from "bun:test";
import { AnthropicMessagesProvider } from "../src/services/ai/providers/anthropic-messages.js";
import type { ChatCompletionTool } from "../src/services/ai/tools/tool-schema.js";

const toolSchema: ChatCompletionTool = {
  type: "function",
  function: {
    name: "save_memories",
    description: "Save memories",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

class FakeSessionManager {
  private readonly session = { id: "session-1" };
  private readonly messages: any[] = [];

  getSession(): any {
    return null;
  }

  createSession(): any {
    return this.session;
  }

  getMessages(): any[] {
    return this.messages;
  }

  getLastSequence(): number {
    return this.messages.length - 1;
  }

  addMessage(message: any): void {
    this.messages.push(message);
  }
}

type RecordedRequest = {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function makeServer(respond: () => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = JSON.parse((await req.text()) || "{}") as Record<string, unknown>;
      requests.push({
        url: req.url,
        path: new URL(req.url).pathname,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      });
      return respond();
    },
  });
  return { server, requests, url: String(server.url) };
}

describe("AnthropicMessagesProvider", () => {
  it("sends required max_tokens in Anthropic message requests", async () => {
    const { server, url, requests } = makeServer(
      () => new Response("bad request", { status: 400 })
    );
    try {
      const provider = new AnthropicMessagesProvider(
        {
          model: "claude-3-5-sonnet-latest",
          apiUrl: url,
          apiKey: "test-key",
        },
        new FakeSessionManager() as any
      );

      await provider.executeToolCall("system", "user", toolSchema, "session-id");

      const capturedBody = requests[0]?.body;
      expect(capturedBody).toBeDefined();
      expect(capturedBody?.max_tokens).toBeDefined();
    } finally {
      server.stop(true);
    }
  });

  it("uses configured maxTokens when provided", async () => {
    const { server, url, requests } = makeServer(
      () => new Response("bad request", { status: 400 })
    );
    try {
      const provider = new AnthropicMessagesProvider(
        {
          model: "claude-3-5-sonnet-latest",
          apiUrl: url,
          apiKey: "test-key",
          maxTokens: 2048,
        },
        new FakeSessionManager() as any
      );

      await provider.executeToolCall("system", "user", toolSchema, "session-id");

      expect(requests[0]?.body.max_tokens).toBe(2048);
    } finally {
      server.stop(true);
    }
  });
});
