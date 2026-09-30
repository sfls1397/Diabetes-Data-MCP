import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { packageVersion } from "../version.js";

/**
 * stdio -> HTTP bridge for clients that only launch local stdio servers
 * (Claude Desktop on another Mac). Same shape as network-tools-mcp http-proxy.
 */
export async function runHttpStdioProxy(url: string, token: string | undefined): Promise<void> {
  if (!token) throw new Error("DIABETES_DATA_MCP_TOKEN is required");
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("MCP URL must use http or https");
  const remote = new Client({ name: "diabetes-data-http-proxy", version: packageVersion() });
  await remote.connect(
    new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  );
  const server = new Server(
    { name: "diabetes-data-http-proxy", version: packageVersion() },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) => remote.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    remote.callTool(request.params, undefined, { timeout: 15 * 60 * 1000 })
  );
  server.onclose = () => {
    void remote.close();
  };
  await server.connect(new StdioServerTransport());
}
