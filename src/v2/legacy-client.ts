import type { Context } from "@opencode/plugin/promise/plugin";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isCaptureEvidenceEvent } from "../services/capture-evidence-events.js";
import type { MemToastPayload } from "./toast-rpc.js";

type LegacyPart = { type?: string; text?: string; metadata?: unknown };

function textFromParts(parts: LegacyPart[] = []): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced);
    } catch {}
  }

  const candidate = fenced ?? trimmed;
  let lastParsed: unknown;
  let searchFrom = 0;
  while (searchFrom < candidate.length) {
    const start = candidate.indexOf("{", searchFrom);
    if (start < 0) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let found = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          found = true;
          try {
            lastParsed = JSON.parse(candidate.slice(start, i + 1));
          } catch {}
          searchFrom = i + 1;
          break;
        }
      }
    }
    if (!found) break;
  }

  return lastParsed;
}

function legacyMessage(message: any, sessionID: string): any {
  if (message.type === "user" || message.type === "synthetic" || message.type === "system") {
    return {
      info: { id: message.id, sessionID, role: "user", agent: message.agent },
      parts: [
        {
          id: `${message.id}-text`,
          sessionID,
          messageID: message.id,
          type: "text",
          text: message.text ?? "",
          synthetic: message.type !== "user",
        },
      ],
    };
  }
  if (message.type === "assistant") {
    return {
      info: {
        id: message.id,
        sessionID,
        role: "assistant",
        agent: message.agent,
        mode: message.agent,
      },
      parts: (message.content ?? []).map((part: any, index: number) => ({
        id: part.id ?? `${message.id}-${index}`,
        sessionID,
        messageID: message.id,
        ...part,
      })),
    };
  }
  if (message.type === "compaction") {
    return {
      info: {
        id: message.id,
        sessionID,
        role: "assistant",
        summary: true,
        mode: "compaction",
      },
      parts: [],
    };
  }
  return {
    info: { id: message.id ?? randomUUID(), sessionID, role: "assistant" },
    parts: [],
  };
}

function sessionIDFrom(input: any): string | undefined {
  return input?.sessionID ?? input?.path?.id;
}

function bodyFrom(input: any): any {
  return input?.body ?? input ?? {};
}

function schemaPrompt(body: any): string {
  const sections = [body.system, textFromParts(body.parts)];
  if (body.format?.type === "json_schema" && body.format.schema) {
    sections.push(
      [
        "Return only one JSON object matching this JSON Schema.",
        "Do not wrap the JSON in Markdown.",
        "No tools are available in this request. Do not attempt to call any tool; your entire reply must be only the JSON object.",
        JSON.stringify(body.format.schema),
      ].join("\n")
    );
  }
  return sections.filter(Boolean).join("\n\n");
}

export type ToastEmitter = {
  events: {
    emit: (name: "toast", data: MemToastPayload) => Promise<void>;
  };
};

function toastPayloadFrom(input: any): MemToastPayload | null {
  const body = bodyFrom(input);
  const message = typeof body.message === "string" ? body.message : "";
  if (!message) return null;

  const payload: {
    message: string;
    title?: string;
    variant?: MemToastPayload["variant"];
    duration?: number;
    sessionID?: string;
  } = { message };
  if (typeof body.title === "string" && body.title) payload.title = body.title;
  if (
    body.variant === "info" ||
    body.variant === "success" ||
    body.variant === "warning" ||
    body.variant === "error"
  ) {
    payload.variant = body.variant;
  }
  if (typeof body.duration === "number" && Number.isFinite(body.duration)) {
    payload.duration = body.duration;
  }
  if (typeof body.sessionID === "string" && body.sessionID) {
    payload.sessionID = body.sessionID;
  }
  return payload;
}

function toastFallback(input: any): { data: false } {
  const body = bodyFrom(input);
  const message = [body.title, body.message].filter(Boolean).join(": ");
  if (message) {
    const method =
      body.variant === "error" ? "error" : body.variant === "warning" ? "warn" : "info";
    console[method](`[opencode-mem] ${message}`);
  }
  return { data: false };
}

async function showToastViaRpc(
  toastRpc: ToastEmitter | undefined,
  input: any
): Promise<{ data: boolean }> {
  if (!toastRpc) return toastFallback(input);

  const payload = toastPayloadFrom(input);
  if (!payload) return toastFallback(input);

  try {
    await toastRpc.events.emit("toast", payload);
    return { data: true };
  } catch {
    return toastFallback(input);
  }
}

/**
 * Adapts the released OpenCode v2 plugin context to the V1 client shape used
 * by the shared opencode-mem implementation.
 */
export function createLegacyClient(ctx: Context, toastRpc?: ToastEmitter) {
  const generatedSessions = new Set<string>();

  const client = {
    app: { log: async () => ({ data: true }) },
    provider: {
      list: async () => {
        const providers = await ctx.provider.list();
        const connected = [
          ...new Set(
            providers.data
              .filter(
                (provider) => provider.activation === "auto" || provider.activation === "enabled"
              )
              .map((provider) => provider.id)
          ),
        ];
        return { data: { connected } };
      },
    },
    tui: {
      showToast: async (input: any) => showToastViaRpc(toastRpc, input),
      appendPrompt: async () => ({ data: false }),
      submitPrompt: async () => ({ data: false }),
    },
    session: {
      get: async (input: any) => {
        const sessionID = sessionIDFrom(input);
        if (!sessionID) throw new Error("session id required");
        return { data: await ctx.session.get({ sessionID }) };
      },
      messages: async (input: any) => {
        const sessionID = sessionIDFrom(input);
        if (!sessionID) throw new Error("session id required");
        return {
          data: (await ctx.session.context({ sessionID })).map((message: any) =>
            legacyMessage(message, sessionID)
          ),
        };
      },
      create: async () => {
        const id = randomUUID();
        generatedSessions.add(id);
        return { data: { id } };
      },
      prompt: async (input: any) => {
        const sessionID = sessionIDFrom(input);
        if (!sessionID) throw new Error("session id required");
        const body = bodyFrom(input);

        if (generatedSessions.has(sessionID)) {
          const model =
            body.model?.providerID && body.model?.modelID
              ? {
                  providerID: body.model.providerID,
                  id: body.model.modelID,
                  ...(typeof body.variant === "string" && body.variant
                    ? { variant: body.variant }
                    : {}),
                }
              : undefined;
          const generated = await ctx.generate.text({
            prompt: schemaPrompt(body),
            ...(model ? { model } : {}),
          });
          const text = generated?.text ?? "";
          const structured = body.format?.type === "json_schema" ? parseJson(text) : undefined;
          return {
            data: {
              info: {
                id: randomUUID(),
                role: "assistant",
                structured_output: structured,
                structured,
              },
              parts: [{ type: "text", text }],
            },
          };
        }

        const text = textFromParts(body.parts);
        if (body.noReply) {
          const data = await ctx.session.synthetic({
            sessionID,
            text,
            description: "memory context",
            metadata: body.parts?.[0]?.metadata,
          });
          return { data, response: new Response(null, { status: 200 }) };
        }
        const data = await ctx.session.prompt({
          sessionID,
          text,
          delivery: "queue",
          metadata: body.parts?.[0]?.metadata,
        });
        return { data, response: new Response(null, { status: 200 }) };
      },
      abort: async (input: any) => {
        const sessionID = sessionIDFrom(input);
        if (sessionID && generatedSessions.has(sessionID)) {
          generatedSessions.delete(sessionID);
          return { data: true };
        }
        if (sessionID) {
          const result = await ctx.session.interrupt({ sessionID });
          return { data: result.interrupted };
        }
        return { data: false };
      },
      delete: async (input: any) => {
        const sessionID = sessionIDFrom(input);
        if (sessionID) generatedSessions.delete(sessionID);
        return { data: true };
      },
    },
  };

  return client as any;
}

export function legacyToolResult(value: unknown): { content: string; metadata?: unknown } {
  if (typeof value === "string") return { content: value };
  if (value && typeof value === "object" && typeof (value as any).output === "string") {
    return { content: (value as any).output, metadata: (value as any).metadata };
  }
  return { content: JSON.stringify(value ?? null) };
}

const LEGACY_EVENT_ALIASES: Record<string, string> = {
  "session.compaction.ended": "session.compacted",
  "session.execution.succeeded": "session.idle",
  "session.execution.failed": "session.idle",
  "session.execution.interrupted": "session.idle",
};

export function toLegacyEvent(raw: any): { type: string; properties: any } {
  const envelope = raw?.payload ?? raw;
  const source = envelope?.type === "sync" && envelope.syncEvent ? envelope.syncEvent : envelope;
  const rawType =
    typeof source?.type === "string" ? source.type.replace(/\.\d+$/, "") : source?.type;
  const type = typeof rawType === "string" ? (LEGACY_EVENT_ALIASES[rawType] ?? rawType) : rawType;
  const data = source?.data ?? {};
  if (source && typeof source === "object" && "properties" in source) {
    return { type, properties: source.properties };
  }
  if (type === "session.created" || type === "session.updated") {
    return { type, properties: { info: data.session ?? data.info ?? data } };
  }
  return { type, properties: data };
}

export async function eventBelongsToLocation(
  ctx: Context,
  raw: any,
  ownsPendingSession?: (sessionID: string) => Promise<boolean>
): Promise<boolean> {
  const directory =
    raw?.location?.directory ??
    raw?.directory ??
    raw?.payload?.location?.directory ??
    raw?.payload?.directory ??
    raw?.data?.info?.directory;
  if (typeof directory === "string") {
    return resolve(directory) === resolve(ctx.location.directory);
  }

  const event = toLegacyEvent(raw);
  const data = event.properties;
  const sessionID =
    data?.sessionID ??
    data?.part?.sessionID ??
    data?.info?.sessionID ??
    data?.session?.id ??
    (event.type.startsWith("session.") ? data?.info?.id : undefined);
  if (sessionID) {
    try {
      const session: any = await ctx.session.get({ sessionID });
      const sessionDirectory =
        session?.location?.directory ?? session?.directory ?? session?.data?.directory;
      return (
        typeof sessionDirectory === "string" &&
        resolve(sessionDirectory) === resolve(ctx.location.directory)
      );
    } catch {
      if (
        typeof sessionID === "string" &&
        isCaptureEvidenceEvent(event.type) &&
        ownsPendingSession
      ) {
        try {
          return await ownsPendingSession(sessionID);
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  const envelope = raw?.payload ?? raw;
  const source = envelope?.type === "sync" && envelope.syncEvent ? envelope.syncEvent : envelope;
  const rawType = typeof source?.type === "string" ? source.type.replace(/\.\d+$/, "") : undefined;
  return rawType === "provider.updated" || rawType === "model.updated";
}
