import { describe, expect, it } from "bun:test";
import {
  CheaperInferenceProvider,
  CHEAPER_INFERENCE_API_URL,
  CHEAPER_INFERENCE_DEFAULT_MODEL,
} from "../src/services/ai/providers/cheaper-inference.js";
import { AIProviderFactory } from "../src/services/ai/ai-provider-factory.js";
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
  lastCreateSessionArgs: any;

  getSession(sessionId?: string, provider?: string): any {
    void sessionId;
    void provider;
    return null;
  }

  createSession(args: any): any {
    this.lastCreateSessionArgs = args;
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

function makeProvider(
  overrides: Record<string, unknown> = {},
  sessionManager = new FakeSessionManager()
) {
  return {
    provider: new CheaperInferenceProvider(
      {
        model: "",
        apiUrl: "",
        apiKey: "ci-test-key",
        ...overrides,
      },
      sessionManager as any
    ),
    sessionManager,
  };
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

describe("CheaperInferenceProvider", () => {
  it("reports the cheaper-inference provider name", () => {
    const { provider } = makeProvider();
    expect(provider.getProviderName()).toBe("cheaper-inference");
    expect(provider.supportsSession()).toBe(true);
  });

  it("defaults to the Cheaper Inference endpoint when apiUrl is not configured", () => {
    const { provider } = makeProvider();
    expect(provider.resolveEndpoint()).toBe(CHEAPER_INFERENCE_API_URL);
  });

  it("strips a trailing slash from a configured apiUrl", () => {
    const { provider } = makeProvider({ apiUrl: "https://proxy.example.com/v1/" });
    expect(provider.resolveEndpoint()).toBe("https://proxy.example.com/v1");
  });

  it("defaults to gpt-5.4-mini", () => {
    const { provider } = makeProvider();
    expect(provider.resolveModel()).toBe(CHEAPER_INFERENCE_DEFAULT_MODEL);
  });

  it("returns a configured model unchanged", () => {
    const { provider } = makeProvider({ model: "claude-sonnet-5" });
    expect(provider.resolveModel()).toBe("claude-sonnet-5");
  });

  it("records the cheaper-inference session provider tag", async () => {
    const { server, url } = makeServer(() => new Response("login fail", { status: 401 }));
    try {
      const { provider, sessionManager } = makeProvider({ apiUrl: url });
      await provider.executeToolCall("system", "user", toolSchema, "session-id");

      expect(sessionManager.lastCreateSessionArgs?.provider).toBe("cheaper-inference");
    } finally {
      server.stop(true);
    }
  });

  it("targets /chat/completions on Cheaper Inference and authenticates with Bearer", async () => {
    const { server, url, requests } = makeServer(() => new Response("login fail", { status: 401 }));
    try {
      const { provider } = makeProvider({ apiUrl: url });
      await provider.executeToolCall("system", "user", toolSchema, "session-id");

      expect(requests[0]?.path).toBe("/chat/completions");
      expect(requests[0]?.headers["authorization"]).toBe("Bearer ci-test-key");
    } finally {
      server.stop(true);
    }
  });

  it("sends the resolved default model in the request body", async () => {
    const { server, url, requests } = makeServer(() => new Response("login fail", { status: 401 }));
    try {
      const { provider } = makeProvider({ apiUrl: url });
      await provider.executeToolCall("system", "user", toolSchema, "session-id");

      const body = requests[0]?.body;
      expect(body?.model).toBe(CHEAPER_INFERENCE_DEFAULT_MODEL);
      expect(body?.tool_choice).toBe("required");
      expect(Array.isArray(body?.messages)).toBe(true);
      expect(Array.isArray(body?.tools)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("extracts tool input from an OpenAI-format response", async () => {
    const { server, url } = makeServer(() =>
      Response.json({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "save_memories",
                    arguments: JSON.stringify({ memory: "captured fact" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    );
    try {
      const { provider } = makeProvider({ apiUrl: url });
      const result = await provider.executeToolCall("system", "user", toolSchema, "session-id");

      expect(result.success).toBe(true);
      expect((result.data as any).memory).toBe("captured fact");
    } finally {
      server.stop(true);
    }
  });
});

describe("AIProviderFactory cheaper-inference wiring", () => {
  it("creates a Cheaper Inference provider and lists it as supported", () => {
    const provider = AIProviderFactory.createProvider("cheaper-inference", {
      model: "",
      apiUrl: "",
      apiKey: "ci-test-key",
    });
    expect(provider).toBeInstanceOf(CheaperInferenceProvider);
    expect(provider.getProviderName()).toBe("cheaper-inference");
    expect(AIProviderFactory.getSupportedProviders()).toContain("cheaper-inference");
  });
});
