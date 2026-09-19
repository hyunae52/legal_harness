#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SERVER_URL = process.env.TAXLAB_SERVER_URL || "http://136.67.179.84:3000";
const API_KEY = process.env.TAXLAB_API_KEY || "taxlab_partner_2026";

async function main() {
  const sseUrl = new URL("/sse", SERVER_URL);
  sseUrl.searchParams.set("apiKey", API_KEY);

  const remoteTransport = new SSEClientTransport(sseUrl);
  const remoteClient = new Client({ name: "hermes-bridge-client", version: "1.0.0" });
  await remoteClient.connect(remoteTransport);

  const localServer = new Server(
    { name: "taxlab-hermes-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  localServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return await remoteClient.listTools();
  });

  localServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await remoteClient.callTool({ name, arguments: args });
  });

  const stdioTransport = new StdioServerTransport();
  await localServer.connect(stdioTransport);
}

main().catch(err => {
  console.error("[Hermes Bridge Error]:", err.message);
  process.exit(1);
});
