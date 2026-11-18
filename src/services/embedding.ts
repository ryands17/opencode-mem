import { CONFIG } from "../config.js";
import { log, safeLog } from "./logger.js";

const TIMEOUT_MS = 30000;
const GLOBAL_EMBEDDING_KEY = Symbol.for("opencode-mem.embedding.instance");
const MAX_CACHE_SIZE = 100;
/**
 * Per-attempt ceiling for one remote embedding HTTP call. Kept at 8s so
 * 3 attempts + linear backoff stay under the outer embedWithTimeout budget
 * (TIMEOUT_MS = 30s). A single hung request costs one attempt instead of the
 * whole budget (#400: one transient hang previously aborted an entire import
 * with zero memories written).
 */
const REMOTE_ATTEMPT_TIMEOUT_MS = 8000;
/** Attempts per remote embedding call: 1 try + 2 retries on transient failures. */
const REMOTE_MAX_ATTEMPTS = 3;
/** Base backoff between remote embedding attempts; scales linearly (backoffMs * attempt). */
const REMOTE_RETRY_BACKOFF_MS = 500;

export type EmbeddingTask = "document" | "query";

export type EmbedOptions = {
  task?: EmbeddingTask;
};

const NOMIC_TASK_PREFIXES: Record<EmbeddingTask, string> = {
  document: "search_document: ",
  query: "search_query: ",
};

export type EmbeddingTaskPrefixOptions = {
  useTaskPrefixes?: boolean;
  queryPrefix?: string;
  documentPrefix?: string;
};

/**
 * Resolve the prefix for a task: explicit/custom → Nomic (when enabled) → none.
 * Empty string means "no prefix" (disables Nomic fallback for that task).
 */
export function resolveEmbeddingTaskPrefix(
  task: EmbeddingTask,
  options: EmbeddingTaskPrefixOptions = {}
): string {
  const custom = task === "query" ? options.queryPrefix : options.documentPrefix;
  if (custom !== undefined) return custom;
  if (options.useTaskPrefixes) return NOMIC_TASK_PREFIXES[task];
  return "";
}

/**
 * Apply task prefixes when configured.
 * Cache keys and API inputs should use the returned string.
 *
 * Third argument accepts the legacy boolean (`useTaskPrefixes`) or an options
 * object. Defaults read from CONFIG (custom/preset prefixes + Nomic flag).
 */
export function applyEmbeddingTaskPrefix(
  text: string,
  options?: EmbedOptions,
  useTaskPrefixesOrOpts: boolean | EmbeddingTaskPrefixOptions = {
    useTaskPrefixes: CONFIG.embeddingUseTaskPrefixes,
    queryPrefix: CONFIG.embeddingQueryPrefix,
    documentPrefix: CONFIG.embeddingDocumentPrefix,
  }
): string {
  if (!options?.task) return text;

  const prefixOpts: EmbeddingTaskPrefixOptions =
    typeof useTaskPrefixesOrOpts === "boolean"
      ? {
          useTaskPrefixes: useTaskPrefixesOrOpts,
          queryPrefix: CONFIG.embeddingQueryPrefix,
          documentPrefix: CONFIG.embeddingDocumentPrefix,
        }
      : {
          useTaskPrefixes: useTaskPrefixesOrOpts.useTaskPrefixes ?? CONFIG.embeddingUseTaskPrefixes,
          queryPrefix: useTaskPrefixesOrOpts.queryPrefix ?? CONFIG.embeddingQueryPrefix,
          documentPrefix: useTaskPrefixesOrOpts.documentPrefix ?? CONFIG.embeddingDocumentPrefix,
        };

  const prefix = resolveEmbeddingTaskPrefix(options.task, prefixOpts);
  if (!prefix) return text;
  if (text.startsWith(prefix)) return text;
  return `${prefix}${text}`;
}

function embeddingCacheFingerprint(): string {
  return [
    CONFIG.embeddingModel,
    CONFIG.embeddingQueryPrefix ?? "",
    CONFIG.embeddingDocumentPrefix ?? "",
    CONFIG.embeddingUseTaskPrefixes ? "1" : "0",
  ].join("\0");
}

/**
 * Remote embeddings are the only backend (the local ONNX/transformers path was
 * removed — it required native bindings that do not ship for darwin/x64).
 * Both `embeddingApiUrl` and `embeddingApiKey` must be configured.
 */
export function missingRemoteEmbeddingConfigError(): Error {
  const missing = [
    !CONFIG.embeddingApiUrl ? "embeddingApiUrl" : null,
    !CONFIG.embeddingApiKey ? "embeddingApiKey" : null,
  ].filter(Boolean);
  return new Error(
    `Remote embeddings are required but not configured: ${missing.join(", ")} is missing. ` +
      `Set both in the global opencode-mem config.`
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

/** Remote embedding call failed with an HTTP status. */
export class EmbeddingHttpError extends Error {
  constructor(
    public readonly status: number,
    statusText: string
  ) {
    super(`API embedding failed: ${status} ${statusText}`);
    this.name = "EmbeddingHttpError";
  }
}

/**
 * Classify an embedding fetch failure as retryable. Only transient conditions
 * are retried: HTTP 429/5xx, per-attempt AbortSignal timeouts, and network
 * TypeErrors from fetch. JSON parse errors, other 4xx, and unexpected errors
 * fail fast so programming/shape bugs are not amplified across attempts.
 */
function isRetryableEmbeddingError(error: unknown): boolean {
  if (error instanceof EmbeddingHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  // fetch network failures surface as TypeError; AbortSignal.timeout may too
  // depending on runtime (Bun/Node) — accept TimeoutError/AbortError names.
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return true;
    if (error instanceof TypeError) return true;
  }
  return false;
}

/**
 * Perform a remote embedding request with bounded retries. Each attempt uses
 * AbortSignal.timeout so a hung connection is cancelled (not orphaned via
 * Promise.race); transient failures (network, abort/timeout, 429, 5xx) are
 * retried with linear backoff, everything else fails fast.
 *
 * `fetchImpl` is injectable for tests.
 */
export async function fetchRemoteEmbeddingWithRetry(
  fetchImpl: typeof fetch,
  input: string,
  options: {
    url?: string;
    apiKey?: string;
    model?: string;
    attemptTimeoutMs?: number;
    maxAttempts?: number;
    backoffMs?: number;
  } = {}
): Promise<any> {
  const url = options.url ?? CONFIG.embeddingApiUrl;
  const apiKey = options.apiKey ?? CONFIG.embeddingApiKey;
  const model = options.model ?? CONFIG.embeddingModel;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? REMOTE_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? REMOTE_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? REMOTE_RETRY_BACKOFF_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(`${url}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input, model }),
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      if (!response.ok) {
        throw new EmbeddingHttpError(response.status, response.statusText);
      }
      try {
        return await response.json();
      } catch (parseError) {
        throw new Error("Invalid embedding API JSON", { cause: parseError });
      }
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryableEmbeddingError(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export class EmbeddingService {
  private initPromise: Promise<void> | null = null;
  public isWarmedUp: boolean = false;
  /** Set when warmup fails permanently; prevents "initializing forever" (#184). */
  public initError: string | null = null;
  private cache: Map<string, Float32Array> = new Map();
  private cachedFingerprint: string | null = null;

  static getInstance(): EmbeddingService {
    if (!(globalThis as any)[GLOBAL_EMBEDDING_KEY]) {
      (globalThis as any)[GLOBAL_EMBEDDING_KEY] = new EmbeddingService();
    }
    return (globalThis as any)[GLOBAL_EMBEDDING_KEY];
  }

  /** Reset warmed-up state; the next embed() re-probes the remote endpoint. */
  async dispose(reason: string = "dispose"): Promise<void> {
    this.isWarmedUp = false;
    this.initPromise = null;
    this.initError = null;
    // Teardown path: a logger failure must not escape close().
    safeLog("Embedding service reset", { reason, model: CONFIG.embeddingModel });
  }

  async warmup(_progressCallback?: (progress: any) => void): Promise<void> {
    if (this.isWarmedUp) return;
    if (this.initError) throw new Error(this.initError);
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initializeModel();
    return this.initPromise;
  }

  private async initializeModel(): Promise<void> {
    try {
      if (!CONFIG.embeddingApiUrl || !CONFIG.embeddingApiKey) {
        throw missingRemoteEmbeddingConfigError();
      }
      // Send a probe request to verify the API endpoint is actually reachable.
      // Uses a minimal embedding of "ping" to test the full request pipeline.
      // Retried on transient failure (#400): a single hung probe previously
      // burned the whole 30s budget and set the sticky initError.
      await fetchRemoteEmbeddingWithRetry(fetch, "ping");
      this.isWarmedUp = true;
      this.initError = null;
      log("Remote embedding endpoint warmed up", {
        model: CONFIG.embeddingModel,
        url: CONFIG.embeddingApiUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.initPromise = null;
      this.initError = message;
      log("Failed to initialize remote embeddings", { error: message });
      throw error;
    }
  }

  async embed(text: string, options?: EmbedOptions): Promise<Float32Array> {
    const fingerprint = embeddingCacheFingerprint();
    if (this.cachedFingerprint !== fingerprint) {
      this.clearCache();
      this.cachedFingerprint = fingerprint;
    }

    const input = applyEmbeddingTaskPrefix(text, options);

    const cached = this.cache.get(input);
    if (cached) return cached;

    if (!this.isWarmedUp && !this.initPromise) {
      await this.warmup();
    }
    if (this.initPromise) {
      await this.initPromise;
    }

    const data: any = await fetchRemoteEmbeddingWithRetry(fetch, input);
    const result = new Float32Array(data.data[0].embedding);

    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(input, result);

    return result;
  }

  async embedWithTimeout(text: string, options?: EmbedOptions): Promise<Float32Array> {
    return withTimeout(this.embed(text, options), TIMEOUT_MS);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const embeddingService = EmbeddingService.getInstance();
