import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { startHttpServer } from "../src/mcp/server.js";
import { createFixture } from "./fixture.js";

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe("HTTP server", () => {
  it("requires the bearer token on /health", async () => {
    const { path, db } = createFixture();
    const server = await startHttpServer({
      db,
      dbPath: path,
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      log: () => {}
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    try {
      const denied = await fetch(`http://127.0.0.1:${port}/health`);
      expect(denied.status).toBe(401);
      const allowed = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: "Bearer test-token" }
      });
      expect(allowed.status).toBe(200);
      const body = (await allowed.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await closeServer(server);
      db.close();
    }
  });

  it("binds the next free port when the preferred port is taken", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const preferred = (blocker.address() as { port: number }).port;
    const { path, db } = createFixture();
    const logs: string[] = [];
    const server = await startHttpServer({
      db,
      dbPath: path,
      host: "127.0.0.1",
      port: preferred,
      token: "test-token",
      log: (message) => logs.push(message)
    });
    const address = server.address();
    const bound = address && typeof address === "object" ? address.port : 0;
    try {
      expect(bound).toBe(preferred + 1);
      const line = logs.join("\n");
      expect(line).toContain(`preferred port ${preferred} is in use`);
      expect(line).toContain(`listening on http://127.0.0.1:${bound}/mcp`);
      const health = await fetch(`http://127.0.0.1:${bound}/health`, {
        headers: { Authorization: "Bearer test-token" }
      });
      expect(health.status).toBe(200);
    } finally {
      await closeServer(server);
      await closeServer(blocker);
      db.close();
    }
  });

  it("serves the 12 tools over Streamable HTTP with the bearer token", async () => {
    const { path, db } = createFixture();
    const server = await startHttpServer({ db, dbPath: path, host: "127.0.0.1", port: 0, token: "test-token", log: () => {} });
    const port = (server.address() as { port: number }).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    try {
      const denied = new Client({ name: "t", version: "0" });
      await expect(
        denied.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer nope" } } }))
      ).rejects.toThrow();
      const client = new Client({ name: "t", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer test-token" } } })
      );
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(
        [
          "get_active_profile",
          "get_coverage",
          "get_daily_stats",
          "get_profile_as_of",
          "get_range_stats",
          "get_settings_vs_delivery",
          "get_weekly_stats",
          "list_profile_changes",
          "list_sgv",
          "list_treatments",
          "query_raw",
          "sync_status"
        ]
      );
      const result = (await client.callTool({ name: "get_range_stats", arguments: { date_from: "2025-11-02" } })) as {
        content: { type: string; text: string }[];
      };
      expect(JSON.parse(result.content[0].text)).toMatchObject({ sgv_count: 300, tir_80_180: 48 });
      await client.close();
    } finally {
      await closeServer(server);
      db.close();
    }
  });
});
