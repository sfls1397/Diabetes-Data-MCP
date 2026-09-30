#!/usr/bin/env node
import fs from "node:fs";
import { ensureAppDir, resolveConfig } from "./config.js";
import { openDatabaseReadOnly } from "./db/open.js";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, loadOrCreateHttpAuthToken, readKeychainSecret } from "./mcp/httpAuth.js";
import { runHttpStdioProxy } from "./mcp/proxy.js";
import { startHttpServer, startStdioServer } from "./mcp/server.js";
import { getAppDir } from "./paths.js";
import { packageVersion } from "./version.js";

const COMMANDS = ["serve", "stdio", "http-token", "http-proxy", "check-config"] as const;
type Command = (typeof COMMANDS)[number];

function usage(): string {
  return `diabetes-data-mcp v${packageVersion()}
  serve         MCP over bearer-token Streamable HTTP (LaunchAgent; default)
  stdio         MCP over stdio (local clients that spawn the server)
  http-token    print the HTTP bearer token (creates it on first use)
  http-proxy <url>  stdio->HTTP bridge for clients like Claude Desktop (token in DIABETES_DATA_MCP_TOKEN)
  check-config  print the resolved DB path, host, and port and exit

This process never writes the diabetes database. com.diabetes-sqlite.sync
(daily 5:15 AM America/Chicago, sync/diabetes-sqlite-sync) is the sole writer.`;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "-h" || arg === "--help" || arg === "help") {
    console.log(usage());
    return;
  }
  const command: Command = (COMMANDS as readonly string[]).includes(arg) ? (arg as Command) : "serve";
  ensureAppDir(getAppDir());

  if (command === "http-token") {
    const existing = readKeychainSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    console.log(existing ?? loadOrCreateHttpAuthToken().token);
    return;
  }
  if (command === "http-proxy") {
    const url = process.argv[3];
    if (!url) throw new Error("usage: diabetes-data-mcp http-proxy <http://mini-address:8424/mcp>");
    await runHttpStdioProxy(url, process.env.DIABETES_DATA_MCP_TOKEN);
    return;
  }
  if (command === "check-config") {
    const config = resolveConfig();
    console.log(`OK: config ${config.configPath}`);
    console.log(`db: ${config.dbPath}`);
    console.log(`preferred listen: http://${config.serverHost}:${config.serverPort}/mcp`);
    console.log("If that port is busy, serve binds the next free port above it and logs the URL it actually bound.");
    return;
  }

  const config = resolveConfig();
  if (!fs.existsSync(config.dbPath)) {
    throw new Error(
      `Diabetes database not found at ${config.dbPath}. This MCP does not create or write it; com.diabetes-sqlite.sync is the sole writer.`
    );
  }
  // Read-only open. Do not create tables, do not call Nightscout, and do
  // not launch or edit com.diabetes-sqlite.sync (daily 5:15 AM CT).
  const db = openDatabaseReadOnly(config.dbPath);

  if (command === "stdio") {
    console.error(`diabetes-data-mcp stdio v${packageVersion()} — DB: ${config.dbPath}`);
    await startStdioServer(db, config.dbPath);
    return;
  }

  const log = (message: string) => console.error(`${new Date().toISOString()} [server] ${message}`);
  const { token } = loadOrCreateHttpAuthToken({ log });
  await startHttpServer({
    db,
    dbPath: config.dbPath,
    host: config.serverHost,
    port: config.serverPort,
    token,
    log
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
