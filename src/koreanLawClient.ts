import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { dirname, isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export class LawMcpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly result?: CallToolResult,
  ) {
    super(message);
    this.name = "LawMcpError";
  }
}

export interface LawMcpOptions {
  server: StdioServerParameters;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  maxConcurrentCalls: number;
  releaseVersion?: string;
}

type Connection = {
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];
  ready: boolean;
  retiring?: Promise<void>;
};

/** One managed child process per Express worker; no upstream modules are imported. */
export class KoreanLawClient {
  private connection?: Connection;
  private connecting?: Promise<Connection>;
  private retiring?: Promise<void>;
  private stopped = false;
  private activeCalls = 0;

  constructor(private readonly options: LawMcpOptions) {}

  get releaseVersion(): string | undefined {
    return this.options.releaseVersion;
  }

  private async retire(connection: Connection): Promise<void> {
    if (connection.retiring) return connection.retiring;
    connection.ready = false;
    if (this.connection === connection) this.connection = undefined;
    const retiring = Promise.resolve().then(async () => {
      await connection.client.close().catch(() => undefined);
      // Also handles spawn failures before the SDK attaches its transport.
      await connection.transport.close().catch(() => undefined);
    });
    connection.retiring = retiring;
    this.retiring = retiring;
    await retiring;
    if (this.retiring === retiring) this.retiring = undefined;
  }

  private async openConnection(): Promise<Connection> {
    const client = new Client({ name: "k-tax-express", version: "2.0.0" });
    const transport = new StdioClientTransport({
      ...this.options.server,
      stderr: "pipe",
      maxBufferSize: 4 * 1024 * 1024,
    });
    // Drain diagnostics without forwarding credentials or corrupting MCP stdout.
    transport.stderr?.on("data", () => {});
    const connection: Connection = { client, transport, tools: [], ready: false };
    this.connection = connection;
    client.onclose = () => {
      connection.ready = false;
      if (this.connection === connection) this.connection = undefined;
    };
    client.onerror = () => { void this.retire(connection); };

    const deadline = Date.now() + this.options.connectTimeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
      await client.connect(transport, { timeout: remaining() });
      if (this.releaseVersion && client.getServerVersion()?.version !== this.releaseVersion) {
        throw new Error("MCP executable version does not match the selected release");
      }
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: remaining() });
        connection.tools.push(...page.tools);
        cursor = page.nextCursor;
        if (connection.tools.length > 1000 || (cursor && (seenCursors.has(cursor) || seenCursors.size >= 20))) {
          throw new Error("Invalid upstream tool pagination");
        }
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      if (this.stopped || this.connection !== connection) throw new Error("Connection closed during startup");
      connection.ready = true;
      return connection;
    } catch (error) {
      await this.retire(connection);
      throw new LawMcpError(503, "MCP_UNAVAILABLE", "korean-law-mcp could not start or initialize.");
    }
  }

  private async getConnection(deadline = Infinity): Promise<Connection> {
    await this.retiring;
    // A caller can expire while the previous child is being reaped. Never
    // create (or join) a new connection on behalf of that expired caller.
    // No connection has been acquired here. Use the pre-acquisition error
    // path, which must not retire another caller's newly created connection.
    if (Date.now() >= deadline) throw new LawMcpError(504, 'MCP_TIMEOUT', 'Legal retrieval expired before acquiring a connection.');
    if (this.stopped) throw new LawMcpError(503, "MCP_CLOSED", "The legal MCP client is shutting down.");
    if (this.connecting) return this.connecting;
    if (this.connection?.ready) return this.connection;
    const connecting = this.openConnection();
    this.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }

  async listTools() {
    const connection = await this.getConnection();
    return { server: connection.client.getServerVersion(), tools: connection.tools };
  }

  async callTool(name: string, args: Record<string, unknown>) {
    if (!this.options.server.env?.LAW_OC) {
      throw new LawMcpError(503, "MCP_NOT_CONFIGURED", "Set LAW_OC on the Express server before requesting legal data.");
    }
    // Keep this slot until work ends, even if the HTTP caller disconnects.
    if (this.activeCalls >= this.options.maxConcurrentCalls) {
      throw new LawMcpError(429, "MCP_AT_CAPACITY", "Legal retrieval is at capacity. Please retry later.");
    }
    this.activeCalls++;
    const deadline = Date.now() + this.options.requestTimeoutMs;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => reject(new McpError(ErrorCode.RequestTimeout, 'Legal retrieval deadline exceeded')), this.options.requestTimeoutMs);
    });
    let connection: Connection | undefined;
    let acquiring: Promise<Connection> | undefined;
    try {
      acquiring = this.getConnection(deadline);
      connection = await Promise.race([acquiring, expired]);
      if (!connection.tools.some(tool => tool.name === name)) {
        throw new LawMcpError(400, "MCP_UNKNOWN_TOOL", "Tool is not advertised by korean-law-mcp. See /api/tools.");
      }
      const remaining = Math.max(1, deadline - Date.now());
      const response = await Promise.race([connection.client.callTool({ name, arguments: args }, CallToolResultSchema, {
        timeout: remaining,
        maxTotalTimeout: remaining,
        resetTimeoutOnProgress: false,
      }), expired]);
      const result = CallToolResultSchema.parse(response);
      if (result.isError) {
        throw new LawMcpError(502, "MCP_TOOL_ERROR", "korean-law-mcp reported a tool failure.", result);
      }
      return {
        kind: "retrieval" as const,
        tool: name,
        server: connection.client.getServerVersion(),
        retrieved_at: new Date().toISOString(),
        // Retain text, resource links, structured content and upstream metadata.
        result,
      };
    } catch (error) {
      if (error instanceof LawMcpError) throw error;
      if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
        throw new LawMcpError(400, "MCP_INVALID_ARGUMENTS", "Arguments do not match the upstream tool. See /api/tools.");
      }
      // A timed-out child may still be doing network work. Retire the process
      // before permitting a fresh connection; never automatically replay calls.
      const retiring = connection ?? this.connection;
      if (retiring) await this.retire(retiring);
      // Retirement clears this.connection before it finishes. A timed-out
      // waiter must still await that cleanup and its own acquisition promise
      // before releasing capacity; Promise.race alone does not cancel it.
      await this.retiring;
      await acquiring?.catch(() => undefined);
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw new LawMcpError(504, "MCP_TIMEOUT", "Legal retrieval timed out; the MCP process was reset.");
      }
      throw new LawMcpError(502, "MCP_CONNECTION_ERROR", "The legal MCP connection failed. A new request can reconnect.");
    } finally {
      clearTimeout(deadlineTimer);
      this.activeCalls--;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.connection) await this.retire(this.connection);
    await this.connecting?.catch(() => undefined);
    await this.retiring;
  }
}

const ConnectTimeoutSchema = z.coerce.number().int().min(100).max(10_000);
const RequestTimeoutSchema = z.coerce.number().int().min(100).max(45_000);

export const McpReleaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  entrypoint: z.string().refine(isAbsolute, "MCP entrypoint must be an absolute path"),
}).strict();

export function koreanLawOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LawMcpOptions {
  // Resolve the executable path without importing/evaluating upstream source.
  const release = env.KOREAN_LAW_MCP_RELEASE_FILE
    ? McpReleaseSchema.parse(JSON.parse(readFileSync(env.KOREAN_LAW_MCP_RELEASE_FILE, "utf8")))
    : undefined;
  if (release && (env.KOREAN_LAW_MCP_COMMAND || env.KOREAN_LAW_MCP_ARGS || env.KOREAN_LAW_MCP_CWD)) {
    throw new Error("Use KOREAN_LAW_MCP_RELEASE_FILE or manual MCP command settings, not both.");
  }
  const entrypoint = release?.entrypoint ?? fileURLToPath(import.meta.resolve("korean-law-mcp"));
  const command = env.KOREAN_LAW_MCP_COMMAND || process.execPath;
  let args = [entrypoint, "--mode", "stdio"];
  if (env.KOREAN_LAW_MCP_COMMAND && !env.KOREAN_LAW_MCP_ARGS) {
    throw new Error("KOREAN_LAW_MCP_COMMAND requires KOREAN_LAW_MCP_ARGS (a JSON string array).");
  }
  if (env.KOREAN_LAW_MCP_ARGS) {
    args = z.array(z.string()).max(32).parse(JSON.parse(env.KOREAN_LAW_MCP_ARGS));
  }
  const childEnv: Record<string, string> = {};
  // Do not inherit Express's Supabase/GitHub credentials or NODE_OPTIONS.
  for (const key of ["LAW_API_PROTOCOL", "MCP_MAX_UPSTREAM_REQUESTS", "MCP_MAX_UPSTREAM_BODY_BYTES",
    "MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES", "MCP_MAX_TOOL_RESPONSE_CHARS"]) {
    if (env[key]) childEnv[key] = env[key];
  }
  childEnv.LAW_OC = env.LAW_OC || env.KOREAN_LAW_API_KEY || "";
  return {
    server: {
      command,
      args,
      env: childEnv,
      // Avoid loading the application's .env in the child process.
      cwd: env.KOREAN_LAW_MCP_CWD || dirname(entrypoint),
    },
    connectTimeoutMs: ConnectTimeoutSchema.parse(env.KOREAN_LAW_MCP_CONNECT_TIMEOUT_MS || 10_000),
    requestTimeoutMs: RequestTimeoutSchema.parse(env.KOREAN_LAW_MCP_TIMEOUT_MS || 45_000),
    maxConcurrentCalls: 3,
    releaseVersion: release?.version,
  };
}

export function createKoreanLawClient(): KoreanLawClient {
  return new KoreanLawClient(koreanLawOptionsFromEnv());
}
