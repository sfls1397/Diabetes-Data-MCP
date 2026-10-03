# Connecting MCP clients to Diabetes Data

Diabetes Data MCP runs on the Mac Mini as a Streamable HTTP MCP server (same
scheme as Network-Tools): every request needs the bearer token, which lives
in the Mini's Keychain (service `diabetes-data-mcp-http`, account
`http-auth-token`). Print it on the Mini with:

```bash
node ~/code/Diabetes-Data-MCP/bin/diabetes-data-mcp.js http-token
```

The server prefers `serverHost`/`serverPort` from
`~/.diabetes-data-mcp/config.json` (`0.0.0.0:8424` by default, so the LAN
can reach it). If that port is already taken, the process binds the next
free port above it and logs the URL it actually bound (`listening on
http://<host>:<port>/mcp`). Use that logged port in every client URL below
when it is not 8424. Use the Mini's Bonjour name `<LocalHostName>.local`
rather than its IP when the address can change.

The archive is refreshed every minute by `com.diabetes-sqlite.sync`
(`StartInterval=60`), which pulls
Nightscout into SQLite. This package has no Nightscout tools, never writes the
database, and never touches that agent. Call `sync_status` to see how fresh
the archive is.

## Claude Code / HTTP clients on the Mini

```bash
claude mcp add --transport http diabetes-data http://127.0.0.1:8424/mcp \
  -H "Authorization: Bearer <token>" -s user
```

Grok Bot (Local Execution / Mini Shell), ChatGPT, and any other MCP client
that speaks Streamable HTTP use the same URL and header:

```json
{
  "mcpServers": {
    "diabetes-data": {
      "url": "http://127.0.0.1:8424/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Claude Code on another Mac (LAN)

```bash
claude mcp add --transport http diabetes-data http://<LocalHostName>.local:8424/mcp \
  -H "Authorization: Bearer <token-from-mini>" -s user
```

## Claude Desktop on the Mini (stdio)

Same tools, no token. The process still opens SQLite read-only.

```json
{
  "mcpServers": {
    "diabetes-data": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/petercoates/code/Diabetes-Data-MCP/bin/diabetes-data-mcp.js", "stdio"]
    }
  }
}
```

## Claude Desktop on another Mac (http-proxy)

Claude Desktop launches local stdio servers. Use the bundled proxy (a checkout
of this repo on that Mac):

```json
{
  "mcpServers": {
    "diabetes-data": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/Diabetes-Data-MCP/bin/diabetes-data-mcp.js",
        "http-proxy",
        "http://<LocalHostName>.local:8424/mcp"
      ],
      "env": { "DIABETES_DATA_MCP_TOKEN": "<token-from-mini>" }
    }
  }
}
```

Claude Desktop's custom connector connects from Anthropic's cloud and cannot
reach a private LAN address. Use the local stdio or http-proxy entry above.

## Away from home

The server is LAN-only by default. For access away from home, run Tailscale
on both Macs and point clients at the Mini's Tailscale name instead of
`.local`. Don't port-forward the bound port (8424, or the next free port named in the server log).

## Rotating the token

Delete the Keychain item (`security delete-generic-password -s diabetes-data-mcp-http -a http-auth-token`),
restart the server (`launchctl kickstart -k gui/$(id -u)/com.diabetes-mcp.server`),
which generates a new one, then update each client.
