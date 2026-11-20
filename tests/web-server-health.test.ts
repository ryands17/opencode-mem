import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { WebServer, nextFallbackPort } from "../src/services/web-server.js";

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

describe("web server health check", () => {
  it("authenticates the stats probe when an API token is configured", async () => {
    let probeUrl: string | undefined;
    let probeAuthorization: string | undefined;
    const recording = Bun.serve({
      port: 0,
      fetch(req) {
        probeUrl = req.url;
        probeAuthorization = req.headers.get("authorization");
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const prober = new WebServer({
        enabled: true,
        host: "127.0.0.1",
        port: recording.port,
        apiToken: "health-token",
      });
      expect(await prober.checkServerAvailable()).toBe(true);
      expect(probeUrl).toBe(`http://127.0.0.1:${recording.port}/api/stats?probe=1`);
      expect(probeAuthorization).toBe("Bearer health-token");
    } finally {
      recording.stop(true);
    }

    const port = freePort();
    const server = new WebServer({
      enabled: true,
      host: "127.0.0.1",
      port,
      apiToken: "health-token",
    });
    await server.start();
    try {
      expect(await server.checkServerAvailable()).toBe(true);

      const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/stats?probe=1`);
      expect(unauthenticated.status).toBe(401);

      const stranger = new WebServer({
        enabled: true,
        host: "127.0.0.1",
        port,
        apiToken: "other-token",
      });
      expect(await stranger.checkServerAvailable()).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("does not treat a 2xx from an unrelated service as an opencode-mem owner", async () => {
    let foreignBody = JSON.stringify({ success: false, status: "degraded" });
    const foreign = Bun.serve({
      port: 0,
      fetch() {
        return new Response(foreignBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const server = new WebServer({ enabled: true, host: "127.0.0.1", port: foreign.port });
      expect(await server.checkServerAvailable()).toBe(false);

      foreignBody = "<!doctype html><h1>elsewhere</h1>";
      expect(await server.checkServerAvailable()).toBe(false);
    } finally {
      foreign.stop(true);
    }
  });

  it("falls back to the next port only after repeated failed takeovers", () => {
    expect(nextFallbackPort(4747, 0, 4757)).toBe(4747);
    expect(nextFallbackPort(4747, 2, 4757)).toBe(4747);
    expect(nextFallbackPort(4747, 3, 4757)).toBe(4748);
    expect(nextFallbackPort(4748, 3, 4757)).toBe(4749);
    expect(nextFallbackPort(4757, 3, 4757)).toBe(4757);
    expect(nextFallbackPort(4757, 99, 4757)).toBe(4757);
  });

  it("becomes owner on a neighbor port after repeated failed takeovers", async () => {
    // WARNING: keep ports below Linux's ephemeral range (32768–60999) or a busy full-suite run flakes the takeover bind (#436).
    const occupy = createServer((_req, res) => {
      res.writeHead(200);
      res.end("occupied");
    });
    await new Promise<void>((resolve) => occupy.listen(28747, "127.0.0.1", resolve));

    try {
      const server = new WebServer({ enabled: true, host: "127.0.0.1", port: 28747 });
      let takeoverCallbacks = 0;
      server.setOnTakeoverCallback(async () => {
        takeoverCallbacks += 1;
      });

      const attemptTakeover = (
        server as unknown as { attemptTakeover(): Promise<void> }
      ).attemptTakeover.bind(server);

      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);
      expect(server.getUrl()).toBe("http://127.0.0.1:28747");

      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);
      expect(server.getUrl()).toBe("http://127.0.0.1:28747");

      await attemptTakeover();
      expect(server.isServerOwner()).toBe(true);
      expect(server.getUrl()).toBe("http://127.0.0.1:28748");
      expect(takeoverCallbacks).toBe(1);

      const response = await fetch(`${server.getUrl()}/api/health`);
      expect(response.status).toBe(200);

      await server.stop();
    } finally {
      await new Promise<void>((resolve) => occupy.close(() => resolve()));
    }
  });

  it("resets the takeover failure counter when the owner recovers", async () => {
    let ownerRecovered = false;
    const occupy = createServer((_req, res) => {
      if (ownerRecovered) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, status: "ok" }));
        return;
      }
      res.writeHead(200);
      res.end("occupied");
    });
    await new Promise<void>((resolve) => occupy.listen(28747, "127.0.0.1", resolve));

    try {
      const server = new WebServer({ enabled: true, host: "127.0.0.1", port: 28747 });

      const attemptTakeover = (
        server as unknown as { attemptTakeover(): Promise<void> }
      ).attemptTakeover.bind(server);

      await attemptTakeover();
      await attemptTakeover();
      expect(server.getUrl()).toBe("http://127.0.0.1:28747");

      ownerRecovered = true;
      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);

      ownerRecovered = false;
      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);
      expect(server.getUrl()).toBe("http://127.0.0.1:28747");

      await server.stop();
    } finally {
      await new Promise<void>((resolve) => occupy.close(() => resolve()));
    }
  });

  it("enters a terminal state when every candidate port is unavailable", async () => {
    const occupy = createServer((_req, res) => {
      res.writeHead(200);
      res.end("occupied");
    });
    await new Promise<void>((resolve) => occupy.listen(28747, "127.0.0.1", resolve));

    try {
      const server = new WebServer({ enabled: true, host: "127.0.0.1", port: 28747 });
      let exhaustedSignals = 0;
      server.setOnPortsExhaustedCallback(() => {
        exhaustedSignals += 1;
      });
      (server as unknown as { maxFallbackPort: number }).maxFallbackPort = 28747;

      const attemptTakeover = (
        server as unknown as { attemptTakeover(): Promise<void> }
      ).attemptTakeover.bind(server);

      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);
      expect(
        (server as unknown as { healthCheckInterval: NodeJS.Timeout | null }).healthCheckInterval
      ).not.toBe(null);

      await attemptTakeover();

      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);
      expect(exhaustedSignals).toBe(1);
      expect(
        (server as unknown as { healthCheckInterval: NodeJS.Timeout | null }).healthCheckInterval
      ).toBe(null);

      await attemptTakeover();
      expect(exhaustedSignals).toBe(1);

      await server.stop();
    } finally {
      await new Promise<void>((resolve) => occupy.close(() => resolve()));
    }
  });
});
