import { describe, expect, it } from "bun:test";
import {
  OrcaRouterProvider,
  ORCAROUTER_API_URL,
  ORCAROUTER_DEFAULT_MODEL,
} from "../src/services/ai/providers/orcarouter.js";
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
    provider: new OrcaRouterProvider(
      {
        model: "",
        apiUrl: "",
        apiKey: "sk-orca-test",
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

describe("OrcaRouterProvider", () => {
  it("reports the orcarouter provider name", () => {
    const { provider } = makeProvider();
    expect(provider.getProviderName()).toBe("orcarouter");
    expect(provider.supportsSession()).toBe(true);
  });

  it("defaults to the OrcaRouter gateway endpoint when apiUrl is not configured", () => {
    const { provider } = makeProvider();
    expect(provider.resolveEndpoint()).toBe(ORCAROUTER_API_URL);
  });

  it("strips a trailing slash from a configured apiUrl", () => {
    const { provider } = makeProvider({ apiUrl: "https://proxy.example.com/v1/" });
    expect(provider.resolveEndpoint()).toBe("https://proxy.example.com/v1");
  });

  it("defaults to the orcarouter/auto routing model", () => {
    const { provider } = makeProvider();
    expect(provider.resolveModel()).toBe(ORCAROUTER_DEFAULT_MODEL);
  });

  it("returns a namespaced configured model unchanged", () => {
    const { provider } = makeProvider({ model: "deepseek/deepseek-v4-flash" });
    expect(provider.resolveModel()).toBe("deepseek/deepseek-v4-flash");
  });

  it("rejects a bare model name with a namespacing hint", () => {
    const { provider } = makeProvider({ model: "gpt-4o-mini" });
    expect(() => provider.resolveModel()).toThrow(/namespaced memoryModel/);
  });

  it("records the orcarouter session provider tag", async () => {
    const { server, url } = makeServer(() => new Response("login fail", { status: 401 }));
    try {
      const { provider, sessionManager } = makeProvider({ apiUrl: url });
      await provider.executeToolCall("system", "user", toolSchema, "session-id");

      expect(sessionManager.lastCreateSessionArgs?.provider).toBe("orcarouter");
    } finally {
      server.stop(true);
    }
  });

  it("targets /chat/completions on the gateway and authenticates with Bearer", async () => {
    const { server, url, requests } = makeServer(() => new Response("login fail", { status: 401 }));
    try {
      const { provider } = makeProvider({ apiUrl: url });
      await provider.executeToolCall("system", "user", toolSchema, "session-id");

      expect(requests[0]?.path).toBe("/chat/completions");
      expect(requests[0]?.headers["authorization"]).toBe("Bearer sk-orca-test");
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
      expect(body?.model).toBe(ORCAROUTER_DEFAULT_MODEL);
      expect(body?.tool_choice).toBe("required");
      expect(Array.isArray(body?.messages)).toBe(true);
      expect(Array.isArray(body?.tools)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("extracts tool input from an OpenAI-format response", async () => {
    const { server, url, requests } = makeServer(() =>
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

      expect(requests[0]?.body.model).toBe(ORCAROUTER_DEFAULT_MODEL);
      expect(result.success).toBe(true);
      expect((result.data as any).memory).toBe("captured fact");
    } finally {
      server.stop(true);
    }
  });
});

describe("AIProviderFactory orcarouter wiring", () => {
  it("creates an OrcaRouter provider and lists it as supported", () => {
    const provider = AIProviderFactory.createProvider("orcarouter", {
      model: "",
      apiUrl: "",
      apiKey: "sk-orca-test",
    });
    expect(provider.getProviderName()).toBe("orcarouter");
    expect(AIProviderFactory.getSupportedProviders()).toContain("orcarouter");
  });
});
