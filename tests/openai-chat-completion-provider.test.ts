import { describe, expect, it } from "bun:test";
import {
  OpenAIChatCompletionProvider,
  isStreamRequiredError,
  parseChatCompletionStream,
} from "../src/services/ai/providers/openai-chat-completion.js";
import type { AIMessage } from "../src/services/ai/session/session-types.js";
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

class TestableOpenAIChatCompletionProvider extends OpenAIChatCompletionProvider {
  filterMessages(messages: AIMessage[]): AIMessage[] {
    return this.filterIncompleteToolCallSequences(messages);
  }
}

function makeProvider(config: Record<string, unknown> = {}) {
  return new OpenAIChatCompletionProvider(
    { model: "gpt-4o-mini", apiKey: "test-key", ...config },
    new FakeSessionManager() as any
  );
}

function makeTestableProvider(config: Record<string, unknown> = {}) {
  return new TestableOpenAIChatCompletionProvider(
    { model: "gpt-4o-mini", apiKey: "test-key", ...config },
    new FakeSessionManager() as any
  );
}

type RecordedRequest = {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function makeServer(
  respond: (request: RecordedRequest, index: number) => Response | Promise<Response>
) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = JSON.parse((await req.text()) || "{}") as Record<string, unknown>;
      const request: RecordedRequest = {
        url: req.url,
        path: new URL(req.url).pathname,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      };
      requests.push(request);
      return respond(request, requests.length - 1);
    },
  });
  return { server, requests, url: String(server.url) };
}

function sseResponse(lines: string[]) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenAIChatCompletionProvider", () => {
  it("getProviderName returns openai-chat", () => {
    expect(makeProvider().getProviderName()).toBe("openai-chat");
  });

  it("supportsSession returns true", () => {
    expect(makeProvider().supportsSession()).toBe(true);
  });

  it("keeps complete tool call sequences", () => {
    const messages: AIMessage[] = [
      {
        aiSessionId: "session-1",
        sequence: 0,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "save_memories", arguments: "{}" },
          },
        ],
        createdAt: 1,
      },
      {
        aiSessionId: "session-1",
        sequence: 1,
        role: "tool",
        content: '{"success":true}',
        toolCallId: "call-1",
        createdAt: 2,
      },
    ];

    expect(makeTestableProvider().filterMessages(messages)).toEqual(messages);
  });

  it("drops trailing incomplete tool call sequences", () => {
    const messages: AIMessage[] = [
      {
        aiSessionId: "session-1",
        sequence: 0,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "save_memories", arguments: "{}" },
          },
        ],
        createdAt: 1,
      },
    ];

    expect(makeTestableProvider().filterMessages(messages)).toEqual([]);
  });

  it("keeps complete prefix and drops later incomplete tool call sequences", () => {
    const messages: AIMessage[] = [
      {
        aiSessionId: "session-1",
        sequence: 0,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "save_memories", arguments: "{}" },
          },
        ],
        createdAt: 1,
      },
      {
        aiSessionId: "session-1",
        sequence: 1,
        role: "tool",
        content: '{"success":true}',
        toolCallId: "call-1",
        createdAt: 2,
      },
      {
        aiSessionId: "session-1",
        sequence: 2,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-2",
            type: "function",
            function: { name: "save_memories", arguments: "{}" },
          },
        ],
        createdAt: 3,
      },
    ];

    expect(makeTestableProvider().filterMessages(messages)).toEqual(messages.slice(0, 2));
  });

  it("uses custom apiUrl for the request", async () => {
    const { server, url, requests } = makeServer(() => new Response("err", { status: 400 }));
    try {
      await makeProvider({ apiUrl: `${url}v1` }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(requests[0]?.path).toBe("/v1/chat/completions");
    } finally {
      server.stop(true);
    }
  });

  it("sends Authorization Bearer header", async () => {
    const { server, url, requests } = makeServer(() => new Response("err", { status: 400 }));
    try {
      await makeProvider({ apiKey: "sk-mykey", apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(requests[0]?.headers["authorization"]).toBe("Bearer sk-mykey");
    } finally {
      server.stop(true);
    }
  });

  it("omits Authorization header when apiKey is not set", async () => {
    const { server, url, requests } = makeServer(() => new Response("err", { status: 400 }));
    try {
      await makeProvider({ apiKey: undefined, apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(requests[0]?.headers["authorization"]).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it("sends model, messages, tools, tool_choice in request body", async () => {
    const { server, url, requests } = makeServer(() => new Response("err", { status: 400 }));
    try {
      await makeProvider({
        model: "gpt-4o-mini",
        apiUrl: url,
      }).executeToolCall("system", "user", toolSchema, "session-id");

      const capturedBody = requests[0]?.body;
      expect(capturedBody?.model).toBe("gpt-4o-mini");
      expect(Array.isArray(capturedBody?.messages)).toBe(true);
      expect(Array.isArray(capturedBody?.tools)).toBe(true);
      expect(capturedBody?.tool_choice).toBe("required");
    } finally {
      server.stop(true);
    }
  });

  it("includes temperature 0.3 by default", async () => {
    const { server, url, requests } = makeServer(() => new Response("err", { status: 400 }));
    try {
      await makeProvider({ apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(requests[0]?.body.temperature).toBe(0.3);
    } finally {
      server.stop(true);
    }
  });

  it("omits temperature when memoryTemperature is false", async () => {
    const { server, url, requests } = makeServer(() => new Response("err", { status: 400 }));
    try {
      await makeProvider({
        memoryTemperature: false,
        apiUrl: url,
      }).executeToolCall("system", "user", toolSchema, "session-id");

      expect(requests[0]?.body.temperature).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it("returns success: false with error message on API error response", async () => {
    const { server, url } = makeServer(() => new Response("Unauthorized", { status: 401 }));
    try {
      const result = await makeProvider({ apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    } finally {
      server.stop(true);
    }
  });

  it("returns friendly message on temperature unsupported error", async () => {
    const { server, url } = makeServer(
      () =>
        new Response('{"error": {"type": "unsupported_value", "param": "temperature"}}', {
          status: 400,
        })
    );
    try {
      const result = await makeProvider({ apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("memoryTemperature");
    } finally {
      server.stop(true);
    }
  });

  it("returns friendly message when thinking mode rejects tool_choice required", async () => {
    const { server, url } = makeServer(
      () => new Response("Thinking mode does not support this tool_choice", { status: 400 })
    );
    try {
      const result = await makeProvider({ apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("forceToolChoice");
      expect(result.error).toContain("false");
    } finally {
      server.stop(true);
    }
  });

  it("returns success: false when response has no choices", async () => {
    const { server, url } = makeServer(() => Response.json({ choices: [] }));
    try {
      const result = await makeProvider({ apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid API response format");
    } finally {
      server.stop(true);
    }
  });

  it("returns success: false when API returns error in response body", async () => {
    const { server, url } = makeServer(() =>
      Response.json({ status: "error", msg: "quota exceeded" })
    );
    try {
      const result = await makeProvider({ apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("quota exceeded");
    } finally {
      server.stop(true);
    }
  });

  it("returns success: true when model calls the correct tool", async () => {
    const validArguments = JSON.stringify({
      preferences: [],
      patterns: [],
      workflows: [],
      codingStyle: {},
      domainKnowledge: [],
    });

    const { server, url } = makeServer(() =>
      Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "save_memories", arguments: validArguments },
                },
              ],
            },
          },
        ],
      })
    );
    try {
      const result = await makeProvider({ apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  it("retries after tool-argument validation failure and succeeds on next attempt", async () => {
    const invalidArguments = JSON.stringify({
      preferences: [],
      patterns: [],
      workflows: "none",
    });
    const validArguments = JSON.stringify({
      preferences: [],
      patterns: [],
      workflows: [],
      codingStyle: {},
      domainKnowledge: [],
    });

    const responses = [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "save_memories", arguments: invalidArguments },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-2",
                  type: "function",
                  function: { name: "save_memories", arguments: validArguments },
                },
              ],
            },
          },
        ],
      },
    ];

    const { server, url, requests } = makeServer((_request, index) =>
      Response.json(responses[index] ?? responses[responses.length - 1])
    );
    try {
      const result = await makeProvider({
        maxIterations: 3,
        apiUrl: url,
      }).executeToolCall("system", "user", toolSchema, "session-id");

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(2);
      expect(requests.length).toBe(2);

      const secondMessages =
        (requests[1]?.body.messages as Array<{ role?: string; content?: string }>) ?? [];
      const retryFeedback = secondMessages.some(
        (msg) =>
          typeof msg.content === "string" &&
          (msg.content.includes("Validation failed") ||
            msg.content.includes("workflows must be an array"))
      );
      expect(retryFeedback).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("returns success: false after max iterations with no tool call", async () => {
    const { server, url } = makeServer(() =>
      Response.json({
        choices: [{ message: { content: "I will not use a tool", tool_calls: undefined } }],
      })
    );
    try {
      const result = await makeProvider({
        maxIterations: 2,
        apiUrl: url,
      }).executeToolCall("system", "user", toolSchema, "session-id");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Max iterations");
      expect(result.iterations).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  it("returns success: false when model calls wrong tool name", async () => {
    const { server, url } = makeServer(() =>
      Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "wrong_tool", arguments: "{}" },
                },
              ],
            },
          },
        ],
      })
    );
    try {
      const result = await makeProvider({
        maxIterations: 1,
        apiUrl: url,
      }).executeToolCall("system", "user", toolSchema, "session-id");

      expect(result.success).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("defaults to tool_choice=required so models cannot answer with prose", async () => {
    const { server, url, requests } = makeServer(() =>
      Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "save_memories", arguments: "{}" },
                },
              ],
            },
          },
        ],
      })
    );
    try {
      await makeProvider({ apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(requests[0]?.body.tool_choice).toBe("required");
    } finally {
      server.stop(true);
    }
  });

  it("honors forceToolChoice=false to fall back to tool_choice=auto", async () => {
    const { server, url, requests } = makeServer(() =>
      Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "save_memories", arguments: "{}" },
                },
              ],
            },
          },
        ],
      })
    );
    try {
      await makeProvider({
        apiUrl: url,
        forceToolChoice: false,
      }).executeToolCall("system", "user", toolSchema, "session-id");

      expect(requests[0]?.body.tool_choice).toBe("auto");
    } finally {
      server.stop(true);
    }
  });

  it("detects non-stream-required API errors", () => {
    expect(isStreamRequiredError(400, "Non-stream chat request is currently not supported")).toBe(
      true
    );
    expect(isStreamRequiredError(400, "endpoint only supports streaming")).toBe(true);
    expect(isStreamRequiredError(400, "unsupported_value temperature")).toBe(false);
    expect(isStreamRequiredError(401, "Non-stream chat request is currently not supported")).toBe(
      false
    );
  });

  it("parses SSE tool-call deltas into a non-streaming response shape", async () => {
    const validArguments = JSON.stringify({
      preferences: [],
      patterns: [],
      workflows: [],
      codingStyle: {},
      domainKnowledge: [],
    });
    const sse = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "save_memories", arguments: "" },
                },
              ],
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: validArguments.slice(0, 20) } }],
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: validArguments.slice(20) } }],
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n");

    const parsed = (await parseChatCompletionStream({
      text: async () => sse,
    } as Response)) as {
      choices: Array<{ message: { tool_calls?: Array<{ function: { arguments: string } }> } }>;
    };

    expect(parsed.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe(validArguments);
  });

  it("retries with stream:true when non-streaming chat is rejected", async () => {
    const validArguments = JSON.stringify({
      preferences: [],
      patterns: [],
      workflows: [],
      codingStyle: {},
      domainKnowledge: [],
    });
    const sse = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "save_memories", arguments: validArguments },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })}`,
      "data: [DONE]",
    ];

    const { server, url, requests } = makeServer((_request, index) =>
      index === 0
        ? new Response("Non-stream chat request is currently not supported", { status: 400 })
        : sseResponse(sse)
    );
    try {
      const result = await makeProvider({ apiUrl: url }).executeToolCall(
        "system",
        "user",
        toolSchema,
        "session-id"
      );

      expect(result.success).toBe(true);
      expect(requests.length).toBe(2);
      expect(requests[0]?.body.stream).toBeUndefined();
      expect(requests[1]?.body.stream).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
