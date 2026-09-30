import http from "node:http";
import type { DatabaseSync } from "../db/open.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { packageVersion } from "../version.js";
import { verifyAuthHeader } from "./httpAuth.js";
import { callTool } from "./queries.js";
import { TOOL_DEFINITIONS } from "./tools.js";

const INSTRUCTIONS = `Diabetes Data MCP: read-only queries against the local diabetes SQLite archive (Nightscout CGM + pump treatments).
- The sole writer is LaunchAgent com.diabetes-sqlite.sync (daily 5:15 AM America/Chicago, Nightscout -> SQLite). This server never writes the database, never calls Nightscout, and never touches that agent. Check sync_status for freshness; data newer than the last sync is not here.
- All dates and HH:MM times are America/Chicago local. Timestamps are returned as ISO UTC plus a local Chicago time.
- Time in range is 80-180 mg/dL only (tir_80_180, under_80, over_180 in percent). Never 70-180.
- Use get_daily_stats / get_weekly_stats for precomputed rollups, get_range_stats for any other window (overnight, meal windows, weekdays), list_sgv / list_treatments for raw rows, get_coverage for gaps, query_raw only as a last resort.
- Not here: live Nightscout, the active pump profile (I:C, CF, basal schedule), or settings math.`;

export function createMcpServer(db: DatabaseSync, dbPath: string): Server {
  const server = new Server(
    { name: "diabetes-data-mcp", version: packageVersion() },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments || {}) as Record<string, unknown>;
    let text: string;
    try {
      text = callTool(db, request.params.name, args, dbPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      text = JSON.stringify({ error: `Tool error: ${message}` });
    }
    return { content: [{ type: "text", text }] };
  });

  return server;
}

export async function startStdioServer(db: DatabaseSync, dbPath: string): Promise<void> {
  const server = createMcpServer(db, dbPath);
  await server.connect(new StdioServerTransport());
}

export interface StartHttpOptions {
  db: DatabaseSync;
  dbPath: string;
  host: string;
  port: number;
  token: string;
  log?: (message: string) => void;
}

const MAX_TCP_PORT = 65535;

function listenOnce(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function isAddrInUse(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "EADDRINUSE";
}

function boundPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind a TCP port");
  return address.port;
}

/**
 * Bind `preferredPort`, or the next free port above it when that port is
 * already taken. Port 0 keeps Node's ephemeral bind (tests only; product
 * config never uses 0).
 */
export async function bindPreferredPort(server: http.Server, host: string, preferredPort: number): Promise<number> {
  if (preferredPort === 0) {
    await listenOnce(server, host, 0);
    return boundPort(server);
  }
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > MAX_TCP_PORT) {
    throw new Error(`port must be an integer from 1 to ${MAX_TCP_PORT} (got ${preferredPort})`);
  }
  for (let port = preferredPort; port <= MAX_TCP_PORT; port++) {
    try {
      await listenOnce(server, host, port);
      return port;
    } catch (err) {
      if (!isAddrInUse(err)) throw err;
    }
  }
  throw new Error(`No free TCP port from ${preferredPort} through ${MAX_TCP_PORT} on ${host}`);
}

/**
 * Stateless Streamable HTTP (a fresh Server + transport per request, as the
 * SDK's stateless example requires), bearer token on every request including
 * /health. Same shape as Network-Tools.
 *
 * `opts.port` is the preferred starting port (default 8424). If it is in use,
 * the server binds the next free port above it and logs the URL it actually bound.
 */
export async function startHttpServer(opts: StartHttpOptions): Promise<http.Server> {
  const log = opts.log || ((message: string) => console.error(message));
  const httpServer = http.createServer((req, res) => {
    if (!verifyAuthHeader(req.headers.authorization, opts.token)) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "Unauthorized: missing or invalid bearer token" }));
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad request" }));
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: packageVersion() }));
      return;
    }
    if (url.pathname !== "/mcp" && url.pathname !== "/") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    void (async () => {
      const server = createMcpServer(opts.db, opts.dbPath);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
      } catch (err) {
        log(`MCP HTTP request error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
    })();
  });
  const bound = await bindPreferredPort(httpServer, opts.host, opts.port);
  const url = `http://${opts.host}:${bound}/mcp`;
  if (opts.port !== 0 && bound !== opts.port) {
    log(
      `Diabetes Data MCP (v${packageVersion()}) preferred port ${opts.port} is in use; listening on ${url}`
    );
  } else {
    log(`Diabetes Data MCP (v${packageVersion()}) listening on ${url}`);
  }
  return httpServer;
}
