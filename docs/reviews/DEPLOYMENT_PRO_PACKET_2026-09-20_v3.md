# Final bounded follow-up: P2 A and B

Immutable code commit: 1fb66e176dba757452899db3fc21a8c5f8ce61dd

Only the remaining A/B findings from the second review and regressions introduced by these fixes are requested. Prior R1-R3 are already resolved; do not restart the complete plan review. Draft PR #3 remains unmerged and no deployment or database migration has occurred. Linux CI has NOT run (workflow scope unavailable; example only). Automatic worker/publishing/activation remain disconnected. Actual production deployment stays HOLD pending HTTPS, closed public TCP 3000, operator approval and operational/rollback validation. DB intake can remain disabled for a retrieval-only release.

A: getConnection receives a request deadline and checks it immediately after retirement, before joining or spawning. Timeout catch waits for retirement and the acquisition promise to settle before returning capacity. The added regression uses a REAL SDK/stdio subprocess kept alive after EOF, not a fake transport. It observes a lifecycle file, asserts the expired second caller remains counted, rejects excess work, checks that no child starts without a live request, and then verifies a new request reconnects. The test failed before the fix (secondSettled=true) and passed after.

B: serialized JSON diagnostics are parsed before recursive field filtering; JSON strings can be nested only within the existing depth/node bounds. Mixed or opaque escaped fragments are omitted. LAW_OC fields are removed independently of value type, and numeric values equal to configured secrets are redacted. Public required fields survive in both REST and real MCP responses; unexpected exceptions remain code-only. New regressions initially failed on JSON headers and numeric LAW_OC, then passed.

Implementer observations (not claims about Pro executing these): npm run review = 67 pass / 0 fail / 0 skipped / 0 cancelled / 0 todo; duration 22659.8223 ms. npm run review:package = six checks pass on Windows with Node 24.13.1. The clean tarball install, actual transports and installed-version proof use local synthetic fixtures, not the live production endpoint.

Final package evidence:
```json
{
  "status": "pass",
  "artifact": "k-tax-agent-backend-2.2.0.tgz",
  "sha256": "9745e8f086a9d7b90e9985772b90952a321e5e0af17a1864f76d578086e96aea",
  "files": 30,
  "checks": [
    "clean_install",
    "stdio_sse_authenticated_call",
    "doctor",
    "packaged_rules",
    "published_lock",
    "installed_dependency_versions"
  ],
  "versions": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@octokit/rest": "21.1.1",
    "@supabase/supabase-js": "2.116.0",
    "dotenv": "16.6.1",
    "express": "4.22.2",
    "js-yaml": "5.4.2",
    "korean-law-mcp": "4.13.0",
    "zod": "3.25.76"
  },
  "fixture_only": true,
  "reviewed_commit": "1fb66e176dba757452899db3fc21a8c5f8ce61dd"
}
```

## src/koreanLawClient.ts
SHA256: c951b6a21b6bdb7f32de8dc4460ea78d13bbd06dc2c89c08e5b6da188fdfbfc7
```text
   1 | import { Client } from "@modelcontextprotocol/sdk/client/index.js";
   2 | import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
   3 | import { CallToolResultSchema, ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
   4 | import { dirname, isAbsolute } from "node:path";
   5 | import { readFileSync } from "node:fs";
   6 | import { fileURLToPath } from "node:url";
   7 | import { z } from "zod";
   8 |
   9 | export class LawMcpError extends Error {
  10 |   constructor(
  11 |     public readonly status: number,
  12 |     public readonly code: string,
  13 |     message: string,
  14 |     public readonly result?: CallToolResult,
  15 |   ) {
  16 |     super(message);
  17 |     this.name = "LawMcpError";
  18 |   }
  19 | }
  20 |
  21 | export interface LawMcpOptions {
  22 |   server: StdioServerParameters;
  23 |   connectTimeoutMs: number;
  24 |   requestTimeoutMs: number;
  25 |   maxConcurrentCalls: number;
  26 |   releaseVersion?: string;
  27 | }
  28 |
  29 | type Connection = {
  30 |   client: Client;
  31 |   transport: StdioClientTransport;
  32 |   tools: Tool[];
  33 |   ready: boolean;
  34 |   retiring?: Promise<void>;
  35 | };
  36 |
  37 | /** One managed child process per Express worker; no upstream modules are imported. */
  38 | export class KoreanLawClient {
  39 |   private connection?: Connection;
  40 |   private connecting?: Promise<Connection>;
  41 |   private retiring?: Promise<void>;
  42 |   private stopped = false;
  43 |   private activeCalls = 0;
  44 |
  45 |   constructor(private readonly options: LawMcpOptions) {}
  46 |
  47 |   get releaseVersion(): string | undefined {
  48 |     return this.options.releaseVersion;
  49 |   }
  50 |
  51 |   private async retire(connection: Connection): Promise<void> {
  52 |     if (connection.retiring) return connection.retiring;
  53 |     connection.ready = false;
  54 |     if (this.connection === connection) this.connection = undefined;
  55 |     const retiring = Promise.resolve().then(async () => {
  56 |       await connection.client.close().catch(() => undefined);
  57 |       // Also handles spawn failures before the SDK attaches its transport.
  58 |       await connection.transport.close().catch(() => undefined);
  59 |     });
  60 |     connection.retiring = retiring;
  61 |     this.retiring = retiring;
  62 |     await retiring;
  63 |     if (this.retiring === retiring) this.retiring = undefined;
  64 |   }
  65 |
  66 |   private async openConnection(): Promise<Connection> {
  67 |     const client = new Client({ name: "k-tax-express", version: "2.0.0" });
  68 |     const transport = new StdioClientTransport({
  69 |       ...this.options.server,
  70 |       stderr: "pipe",
  71 |       maxBufferSize: 4 * 1024 * 1024,
  72 |     });
  73 |     // Drain diagnostics without forwarding credentials or corrupting MCP stdout.
  74 |     transport.stderr?.on("data", () => {});
  75 |     const connection: Connection = { client, transport, tools: [], ready: false };
  76 |     this.connection = connection;
  77 |     client.onclose = () => {
  78 |       connection.ready = false;
  79 |       if (this.connection === connection) this.connection = undefined;
  80 |     };
  81 |     client.onerror = () => { void this.retire(connection); };
  82 |
  83 |     const deadline = Date.now() + this.options.connectTimeoutMs;
  84 |     const remaining = () => Math.max(1, deadline - Date.now());
  85 |     try {
  86 |       await client.connect(transport, { timeout: remaining() });
  87 |       if (this.releaseVersion && client.getServerVersion()?.version !== this.releaseVersion) {
  88 |         throw new Error("MCP executable version does not match the selected release");
  89 |       }
  90 |       let cursor: string | undefined;
  91 |       const seenCursors = new Set<string>();
  92 |       do {
  93 |         const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: remaining() });
  94 |         connection.tools.push(...page.tools);
  95 |         cursor = page.nextCursor;
  96 |         if (connection.tools.length > 1000 || (cursor && (seenCursors.has(cursor) || seenCursors.size >= 20))) {
  97 |           throw new Error("Invalid upstream tool pagination");
  98 |         }
  99 |         if (cursor) seenCursors.add(cursor);
 100 |       } while (cursor);
 101 |       if (this.stopped || this.connection !== connection) throw new Error("Connection closed during startup");
 102 |       connection.ready = true;
 103 |       return connection;
 104 |     } catch (error) {
 105 |       await this.retire(connection);
 106 |       throw new LawMcpError(503, "MCP_UNAVAILABLE", "korean-law-mcp could not start or initialize.");
 107 |     }
 108 |   }
 109 |
 110 |   private async getConnection(deadline = Infinity): Promise<Connection> {
 111 |     await this.retiring;
 112 |     // A caller can expire while the previous child is being reaped. Never
 113 |     // create (or join) a new connection on behalf of that expired caller.
 114 |     if (Date.now() >= deadline) throw new McpError(ErrorCode.RequestTimeout, 'Legal retrieval deadline exceeded');
 115 |     if (this.stopped) throw new LawMcpError(503, "MCP_CLOSED", "The legal MCP client is shutting down.");
 116 |     if (this.connecting) return this.connecting;
 117 |     if (this.connection?.ready) return this.connection;
 118 |     const connecting = this.openConnection();
 119 |     this.connecting = connecting;
 120 |     try {
 121 |       return await connecting;
 122 |     } finally {
 123 |       if (this.connecting === connecting) this.connecting = undefined;
 124 |     }
 125 |   }
 126 |
 127 |   async listTools() {
 128 |     const connection = await this.getConnection();
 129 |     return { server: connection.client.getServerVersion(), tools: connection.tools };
 130 |   }
 131 |
 132 |   async callTool(name: string, args: Record<string, unknown>) {
 133 |     if (!this.options.server.env?.LAW_OC) {
 134 |       throw new LawMcpError(503, "MCP_NOT_CONFIGURED", "Set LAW_OC on the Express server before requesting legal data.");
 135 |     }
 136 |     // Keep this slot until work ends, even if the HTTP caller disconnects.
 137 |     if (this.activeCalls >= this.options.maxConcurrentCalls) {
 138 |       throw new LawMcpError(429, "MCP_AT_CAPACITY", "Legal retrieval is at capacity. Please retry later.");
 139 |     }
 140 |     this.activeCalls++;
 141 |     const deadline = Date.now() + this.options.requestTimeoutMs;
 142 |     let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
 143 |     const expired = new Promise<never>((_resolve, reject) => {
 144 |       deadlineTimer = setTimeout(() => reject(new McpError(ErrorCode.RequestTimeout, 'Legal retrieval deadline exceeded')), this.options.requestTimeoutMs);
 145 |     });
 146 |     let connection: Connection | undefined;
 147 |     let acquiring: Promise<Connection> | undefined;
 148 |     try {
 149 |       acquiring = this.getConnection(deadline);
 150 |       connection = await Promise.race([acquiring, expired]);
 151 |       if (!connection.tools.some(tool => tool.name === name)) {
 152 |         throw new LawMcpError(400, "MCP_UNKNOWN_TOOL", "Tool is not advertised by korean-law-mcp. See /api/tools.");
 153 |       }
 154 |       const remaining = Math.max(1, deadline - Date.now());
 155 |       const response = await Promise.race([connection.client.callTool({ name, arguments: args }, CallToolResultSchema, {
 156 |         timeout: remaining,
 157 |         maxTotalTimeout: remaining,
 158 |         resetTimeoutOnProgress: false,
 159 |       }), expired]);
 160 |       const result = CallToolResultSchema.parse(response);
 161 |       if (result.isError) {
 162 |         throw new LawMcpError(502, "MCP_TOOL_ERROR", "korean-law-mcp reported a tool failure.", result);
 163 |       }
 164 |       return {
 165 |         kind: "retrieval" as const,
 166 |         tool: name,
 167 |         server: connection.client.getServerVersion(),
 168 |         retrieved_at: new Date().toISOString(),
 169 |         // Retain text, resource links, structured content and upstream metadata.
 170 |         result,
 171 |       };
 172 |     } catch (error) {
 173 |       if (error instanceof LawMcpError) throw error;
 174 |       if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
 175 |         throw new LawMcpError(400, "MCP_INVALID_ARGUMENTS", "Arguments do not match the upstream tool. See /api/tools.");
 176 |       }
 177 |       // A timed-out child may still be doing network work. Retire the process
 178 |       // before permitting a fresh connection; never automatically replay calls.
 179 |       const retiring = connection ?? this.connection;
 180 |       if (retiring) await this.retire(retiring);
 181 |       // Retirement clears this.connection before it finishes. A timed-out
 182 |       // waiter must still await that cleanup and its own acquisition promise
 183 |       // before releasing capacity; Promise.race alone does not cancel it.
 184 |       await this.retiring;
 185 |       await acquiring?.catch(() => undefined);
 186 |       if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
 187 |         throw new LawMcpError(504, "MCP_TIMEOUT", "Legal retrieval timed out; the MCP process was reset.");
 188 |       }
 189 |       throw new LawMcpError(502, "MCP_CONNECTION_ERROR", "The legal MCP connection failed. A new request can reconnect.");
 190 |     } finally {
 191 |       clearTimeout(deadlineTimer);
 192 |       this.activeCalls--;
 193 |     }
 194 |   }
 195 |
 196 |   async close(): Promise<void> {
 197 |     this.stopped = true;
 198 |     if (this.connection) await this.retire(this.connection);
 199 |     await this.connecting?.catch(() => undefined);
 200 |     await this.retiring;
 201 |   }
 202 | }
 203 |
 204 | const ConnectTimeoutSchema = z.coerce.number().int().min(100).max(10_000);
 205 | const RequestTimeoutSchema = z.coerce.number().int().min(100).max(45_000);
 206 |
 207 | export const McpReleaseSchema = z.object({
 208 |   version: z.string().regex(/^\d+\.\d+\.\d+$/),
 209 |   entrypoint: z.string().refine(isAbsolute, "MCP entrypoint must be an absolute path"),
 210 | }).strict();
 211 |
 212 | export function koreanLawOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LawMcpOptions {
 213 |   // Resolve the executable path without importing/evaluating upstream source.
 214 |   const release = env.KOREAN_LAW_MCP_RELEASE_FILE
 215 |     ? McpReleaseSchema.parse(JSON.parse(readFileSync(env.KOREAN_LAW_MCP_RELEASE_FILE, "utf8")))
 216 |     : undefined;
 217 |   if (release && (env.KOREAN_LAW_MCP_COMMAND || env.KOREAN_LAW_MCP_ARGS || env.KOREAN_LAW_MCP_CWD)) {
 218 |     throw new Error("Use KOREAN_LAW_MCP_RELEASE_FILE or manual MCP command settings, not both.");
 219 |   }
 220 |   const entrypoint = release?.entrypoint ?? fileURLToPath(import.meta.resolve("korean-law-mcp"));
 221 |   const command = env.KOREAN_LAW_MCP_COMMAND || process.execPath;
 222 |   let args = [entrypoint, "--mode", "stdio"];
 223 |   if (env.KOREAN_LAW_MCP_COMMAND && !env.KOREAN_LAW_MCP_ARGS) {
 224 |     throw new Error("KOREAN_LAW_MCP_COMMAND requires KOREAN_LAW_MCP_ARGS (a JSON string array).");
 225 |   }
 226 |   if (env.KOREAN_LAW_MCP_ARGS) {
 227 |     args = z.array(z.string()).max(32).parse(JSON.parse(env.KOREAN_LAW_MCP_ARGS));
 228 |   }
 229 |   const childEnv: Record<string, string> = {};
 230 |   // Do not inherit Express's Supabase/GitHub credentials or NODE_OPTIONS.
 231 |   for (const key of ["LAW_API_PROTOCOL", "MCP_MAX_UPSTREAM_REQUESTS", "MCP_MAX_UPSTREAM_BODY_BYTES",
 232 |     "MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES", "MCP_MAX_TOOL_RESPONSE_CHARS"]) {
 233 |     if (env[key]) childEnv[key] = env[key];
 234 |   }
 235 |   childEnv.LAW_OC = env.LAW_OC || env.KOREAN_LAW_API_KEY || "";
 236 |   return {
 237 |     server: {
 238 |       command,
 239 |       args,
 240 |       env: childEnv,
 241 |       // Avoid loading the application's .env in the child process.
 242 |       cwd: env.KOREAN_LAW_MCP_CWD || dirname(entrypoint),
 243 |     },
 244 |     connectTimeoutMs: ConnectTimeoutSchema.parse(env.KOREAN_LAW_MCP_CONNECT_TIMEOUT_MS || 10_000),
 245 |     requestTimeoutMs: RequestTimeoutSchema.parse(env.KOREAN_LAW_MCP_TIMEOUT_MS || 45_000),
 246 |     maxConcurrentCalls: 3,
 247 |     releaseVersion: release?.version,
 248 |   };
 249 | }
 250 |
 251 | export function createKoreanLawClient(): KoreanLawClient {
 252 |   return new KoreanLawClient(koreanLawOptionsFromEnv());
 253 | }
 254 |
```

## src/errorDiagnostics.ts
SHA256: 7985d4898f3d9ad3d73a5454352c651707be25af7bf20e465318ebdfb6a1cdca
```text
   1 | import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
   2 | /** Only expected upstream tool-result diagnostics enter this sanitizer. Never
   3 |  * pass an exception, stderr, stack or arbitrary server object to it. */
   4 | export function safeToolDiagnostic(result:CallToolResult,env:NodeJS.ProcessEnv):CallToolResult {
   5 |   const secrets=Object.entries(env).filter(([key,value])=>value&&value.length>=4&&/key|token|secret|password|^LAW_OC$/i.test(key)).flatMap(([,v])=>[v!,encodeURIComponent(v!)]);
   6 |   const omitted='[OMITTED: unparseable or encoded diagnostic]';
   7 |   const scrub=(input:string,max=2000)=>{
   8 |     let text=input;
   9 |     for(const secret of secrets)text=text.split(secret).join('[REDACTED]');
  10 |     text=text.replace(/([?&](?:OC|apiKey|key|token|password)=)[^&#\s]+/gi,'$1[REDACTED]')
  11 |       .replace(/\bBearer\s+[^\s"']+/gi,'Bearer [REDACTED]')
  12 |       .replace(/\b((?:[A-Z_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)|Authorization|OC))\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1=[REDACTED]')
  13 |       .replace(/^\s*(?:at\s+.+|Traceback.*|File ".+", line .*)$/gm,'[INTERNAL TRACE OMITTED]')
  14 |       .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}/g,'[REDACTED]')
  15 |       .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]');
  16 |     return text.slice(0,max);
  17 |   };
  18 |   let budget=120;
  19 |   // MCP peers commonly serialize error objects into content.text (sometimes
  20 |   // more than once). Decode the whole JSON value before applying field policy;
  21 |   // regex-only filtering cannot see headers or JSON-escaped credentials.
  22 |   const cleanText=(input:string,max:number,depth:number):string=>{
  23 |     if(depth>4||input.length>24000)return omitted;
  24 |     const trimmed=input.trim();
  25 |     if(/^[{[\"]/.test(trimmed)) {
  26 |       let parsed:unknown;
  27 |       try {parsed=JSON.parse(trimmed);} catch {return omitted;}
  28 |       const cleaned=clean(parsed,depth+1);
  29 |       const text=typeof cleaned==='string'?cleaned:JSON.stringify(cleaned);
  30 |       return text.length<=max?text:'{"diagnostics_truncated":true}';
  31 |     }
  32 |     // Mixed prose/JSON and escaped fragments have no reliable structural
  33 |     // boundary. Do not expose opaque fragments as a supposedly safe message.
  34 |     if(/[{}]|\\(?:u[0-9a-f]{4}|["\\/bfnrt])/i.test(input))return omitted;
  35 |     return scrub(input,max);
  36 |   };
  37 |   const clean=(value:unknown,depth=0):unknown=>{
  38 |     if(--budget<0||depth>4)return '[OMITTED]';
  39 |     if(typeof value==='string')return cleanText(value,2000,depth);
  40 |     if(typeof value==='number'&&secrets.includes(String(value)))return '[REDACTED]';
  41 |     if(value===null||typeof value==='boolean'||typeof value==='number')return value;
  42 |     if(Array.isArray(value))return value.slice(0,20).map(v=>clean(v,depth+1));
  43 |     if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:token|password|secret|headers?|authorization|cookie|stack|stderr|environment|^env$|api.?key|(?:^|_)oc$|__proto__|constructor)/i.test(key)).slice(0,20).map(([k,v])=>[cleanText(k,100,depth+1),clean(v,depth+1)]));
  44 |     return null;
  45 |   };
  46 |   const content=result.content.filter(c=>c.type==='text').slice(0,3).map(c=>({type:'text' as const,text:cleanText(c.text,3000,0)}));
  47 |   if(!content.length)content.push({type:'text',text:'Upstream tool reported an error. Check the tool arguments or source availability.'});
  48 |   const structured=clean(result.structuredContent);
  49 |   const output:CallToolResult={isError:true,content,...(structured&&typeof structured==='object'&&!Array.isArray(structured)?{structuredContent:structured as Record<string,unknown>}:{})};
  50 |   if(Buffer.byteLength(JSON.stringify(output),'utf8')>16000)return {isError:true,content:[{type:'text',text:scrub(content[0].text,2000)}],structuredContent:{diagnostics_truncated:true}};
  51 |   return output;
  52 | }
  53 |
```

## src/app.ts
SHA256: b04c2b82b42ed0cae17438923bbc7dd2ae08f14ea289d46a03930d265eafdb69
```text
   1 | import express, { type Request, type Response, type NextFunction } from 'express';
   2 | import { Server } from '@modelcontextprotocol/sdk/server/index.js';
   3 | import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
   4 | import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
   5 | import { z } from 'zod';
   6 | import { LawMcpError, type KoreanLawClient } from './koreanLawClient.js';
   7 | import { type Actor, AnalyzeSchema, DraftSchema, type FailureService, ServiceError } from './contracts.js';
   8 | import { GateEngine } from './gates.js';
   9 | import { createAuthenticator } from './auth.js';
  10 | import { retrievalEnvelope } from './evidence.js';
  11 | import { type SourceVerifier } from './sourceVerifier.js';
  12 | import { safeToolDiagnostic } from './errorDiagnostics.js';
  13 |
  14 | interface Options {
  15 |   law: Pick<KoreanLawClient, 'listTools' | 'callTool' | 'close' | 'releaseVersion'>;
  16 |   env?: NodeJS.ProcessEnv;
  17 |   authenticate?: (request: Request) => Promise<Actor>;
  18 |   gates?: GateEngine;
  19 |   failures?: FailureService;
  20 |   sources?: SourceVerifier;
  21 |   maxActive?: number;
  22 |   maxSessions?: number;
  23 |   sessionIdleMs?: number;
  24 | }
  25 | export function createApp(options: Options) {
  26 |   const env = options.env ?? process.env;
  27 |   const auth = options.authenticate ?? createAuthenticator(env);
  28 |   const gates = options.gates ?? new GateEngine();
  29 |   const app = express();
  30 |   app.disable('x-powered-by');
  31 |   app.use(express.json({ limit: '256kb' }));
  32 |   const sessions = new Map<string, { actor: Actor; server: Server; transport: SSEServerTransport; touched: number }>();
  33 |   let active = 0, authActive = 0, stopping = false;
  34 |   const version = options.law.releaseVersion ?? 'unidentified';
  35 |   const maxActive = options.maxActive ?? 3;
  36 |   const work = async <T>(operation: () => Promise<T>): Promise<T> => {
  37 |     if (stopping) throw new ServiceError(503, 'SHUTTING_DOWN');
  38 |     if (active >= maxActive) throw new ServiceError(429, 'AT_CAPACITY');
  39 |     active++;
  40 |     try { return await operation(); } finally { active--; }
  41 |   };
  42 |   const errorBody = (error: unknown) => {
  43 |     if (error instanceof z.ZodError) return { status: 400, body: { code: 'INVALID_INPUT', fields: error.issues.map(i => i.path.join('.')) } };
  44 |     if (error instanceof LawMcpError && error.code==='MCP_TOOL_ERROR' && error.result) return {status:error.status,body:{code:error.code,result:safeToolDiagnostic(error.result,env)}};
  45 |     if (error instanceof ServiceError || error instanceof LawMcpError) return { status: error.status, body: { code: error.code } };
  46 |     return { status: 500, body: { code: 'INTERNAL_ERROR' } };
  47 |   };
  48 |   const fail = (res: Response, error: unknown) => {
  49 |     if (res.headersSent) { res.end(); return; }
  50 |     const r = errorBody(error);
  51 |     if (r.status === 429) res.set('Retry-After', '5');
  52 |     res.status(r.status).json(r.body);
  53 |   };
  54 |   const protectedRoute = (handler: (req: Request, res: Response, actor: Actor) => Promise<unknown>) => (req: Request, res: Response) => {
  55 |     void (async () => {
  56 |       if (stopping || authActive >= 20) throw new ServiceError(429, 'AT_CAPACITY');
  57 |       authActive++;
  58 |       let actor: Actor;
  59 |       try { actor = await auth(req); } finally { authActive--; }
  60 |       const origin = req.get('origin');
  61 |       if (origin && origin !== (env.PUBLIC_ORIGIN || 'https://law.taxlab.kr')) throw new ServiceError(403, 'ORIGIN_REJECTED');
  62 |       await handler(req, res, actor);
  63 |     })().catch(error => fail(res, error));
  64 |   };
  65 |   const validate = (input: unknown) => gates.validate(DraftSchema.parse(input), version);
  66 |   const retrieve = async (name: string, args: Record<string, unknown>, dates: Record<string, string> = {}) => {
  67 |     const result = await options.law.callTool(name, args);
  68 |     const evidence = retrievalEnvelope(name, args, result.result, version, dates);
  69 |     return { ...result, evidence };
  70 |   };
  71 |   const submit = (actor: Actor, input: unknown) => {
  72 |     if (!options.failures) throw new ServiceError(503, 'MAINTENANCE_UNAVAILABLE');
  73 |     return options.failures.submit(actor, input);
  74 |   };
  75 |   app.get('/health', (_req, res) => res.json({ status: stopping ? 'stopping' : 'ok', version: '2.2.0', active_requests: active,
  76 |     mcp_release: options.law.releaseVersion ?? null, rules_version: gates.version, maintenance: options.failures ? 'intake_only' : 'unavailable' }));
  77 |   app.get('/api/tools', protectedRoute(async (_req, res) => res.json({ status: 'success', data: await work(() => options.law.listTools()) })));
  78 |   app.post('/api/validate', protectedRoute(async (req, res) => res.json(await work(async () => validate(req.body)))));
  79 |   app.post('/api/sources/check', protectedRoute(async (req,res) => {
  80 |     if(!options.sources) throw new ServiceError(503,'SOURCE_VERIFIER_UNAVAILABLE');
  81 |     res.json(await work(()=>options.sources!.check(req.body)));
  82 |   }));
  83 |   app.post('/api/analyze', protectedRoute(async (req, res) => {
  84 |     const data = AnalyzeSchema.parse(req.body);
  85 |     return work(async () => {
  86 |       const quality = data.draft_answer ? validate({ draft_answer: data.draft_answer, query: data.query, facts: data.facts,
  87 |         skip_gates: data.skip_gates, mode: data.mode, force: data.force, bypass_reason: data.bypass_reason }) : null;
  88 |       if (quality?.blocked) return res.status(422).json({ code: 'DRAFT_CHECK_FAILED', quality_gate: quality });
  89 |       const args = { ...data.arguments };
  90 |       if (['legal_research', 'search_law', 'search_decisions'].includes(data.tool)) args.query = data.query;
  91 |       return res.json({ status: 'success', data: await retrieve(data.tool, args, data.event_dates), quality_gate: quality });
  92 |     });
  93 |   }));
  94 |   app.post('/api/failures', protectedRoute(async (req, res, actor) => res.status(202).json(await work(() => submit(actor, req.body)))));
  95 |   app.get('/api/failures/:id', protectedRoute(async (req, res, actor) => {
  96 |     const id = z.string().uuid().parse(req.params.id);
  97 |     if (!options.failures) throw new ServiceError(503, 'MAINTENANCE_UNAVAILABLE');
  98 |     res.json(await work(() => options.failures!.status(actor, id)));
  99 |   }));
 100 |   app.post('/api/evolve', protectedRoute(async () => { throw new ServiceError(410, 'USE_SUBMIT_FAILURE'); }));
 101 |
 102 |   const custom: Tool[] = [
 103 |     { name:'check_legal_sources',description:'새 upstream 프로세스로 공식 법령 원문과 역할별 사건일 연혁을 다시 조회합니다. 부칙 해석과 예규 유효성은 별도 미검수입니다.',inputSchema:{type:'object',properties:{law_name:{type:'string'},law_id:{type:'string'},article:{type:'string'},event_dates:{type:'object'}},required:['law_name','law_id'],additionalProperties:false}},
 104 |     ...['validate_legal_draft', 'validate_tax_draft'].map(name => ({ name, description: '제출 초안의 제한된 검사. needs_info/unverified는 법률 통과가 아닙니다. 최종 답변 변경 시 재검사하세요.', inputSchema: { type: 'object' as const, properties: {
 105 |       draft_answer: { type: 'string' }, query: { type: 'string' }, facts: { type: 'object' }, skip_gates: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['strict', 'warn'] }, force: { type: 'boolean' }, bypass_reason: { type: 'string' }
 106 |     }, required: ['draft_answer'], additionalProperties: false } })),
 107 |     { name: 'submit_failure', description: '실패를 영속 접수합니다. 접수는 AI 승인이나 PR 생성을 뜻하지 않습니다. 공유 key로는 사전 정의된 합성 사례만 접수할 수 있습니다.', inputSchema: { type: 'object', properties: {
 108 |       request_id: { type: 'string', format: 'uuid' }, case_id: { type: 'string' }, category: { type: 'string', enum: ['retrieval', 'validation', 'transport'] }, expected: { type: 'string', enum: ['needs_info', 'retrieval', 'reject_invalid_input'] }, actual: { type: 'string', enum: ['passed', 'empty', 'error', 'accepted_invalid_input'] }
 109 |     }, required: ['request_id', 'case_id', 'category', 'expected', 'actual'], additionalProperties: false } },
 110 |   ];
 111 |   function mcpServer(actor: Actor) {
 112 |     const server = new Server({ name: 'taxlab-legal-harness', version: '2.2.0' }, { capabilities: { tools: {} },
 113 |       instructions: '법령 도구 결과는 조회 자료입니다. 사건 기준일·연혁·부칙·후속 해석을 확인하세요. 초안은 validate_legal_draft로 검사하고 미검수/누락 사실을 사용자에게 알리세요. 검사하지 않은 최종 답변을 검수 완료로 표시하지 마세요.' });
 114 |     server.setRequestHandler(ListToolsRequestSchema, () => work(async () => ({ tools: [...(await options.law.listTools()).tools.filter(t => !custom.some(c => c.name === t.name)), ...custom] })));
 115 |     server.setRequestHandler(CallToolRequestSchema, async request => {
 116 |       try {
 117 |         return await work(async () => {
 118 |           const { name, arguments: args = {} } = request.params;
 119 |           if(name==='check_legal_sources') {
 120 |             if(!options.sources) throw new ServiceError(503,'SOURCE_VERIFIER_UNAVAILABLE');
 121 |             const data=await options.sources.check(args);
 122 |             return {content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data};
 123 |           }
 124 |           if (name === 'propose_tax_rule') throw new ServiceError(410, 'USE_SUBMIT_FAILURE');
 125 |           if (name === 'validate_tax_draft' || name === 'validate_legal_draft' || name === 'submit_failure') {
 126 |             const data = name === 'submit_failure' ? await submit(actor, args) : validate(args);
 127 |             return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
 128 |           }
 129 |           const data = await retrieve(name, args);
 130 |           return { ...data.result, _meta: { ...data.result._meta, 'legal-harness/evidence': data.evidence } };
 131 |         });
 132 |       } catch (error) {
 133 |         if(error instanceof LawMcpError && error.code==='MCP_TOOL_ERROR' && error.result)return {...safeToolDiagnostic(error.result,env),_meta:{'legal-harness/error':error.code}};
 134 |         return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorBody(error).body) }] };
 135 |       }
 136 |     });
 137 |     return server;
 138 |   }
 139 |   app.get('/sse', protectedRoute(async (_req, res, actor) => {
 140 |     if (sessions.size >= (options.maxSessions ?? 20) || [...sessions.values()].filter(s => s.actor.id === actor.id).length >= 5) throw new ServiceError(429, 'SESSION_CAPACITY');
 141 |     const transport = new SSEServerTransport('/messages', res);
 142 |     const server = mcpServer(actor);
 143 |     sessions.set(transport.sessionId, { actor, server, transport, touched: Date.now() });
 144 |     res.once('close', () => { sessions.delete(transport.sessionId); void server.close(); });
 145 |     try { await server.connect(transport); } catch (error) { sessions.delete(transport.sessionId); await server.close(); throw error; }
 146 |   }));
 147 |   app.post('/messages', protectedRoute(async (req, res, actor) => {
 148 |     const id = z.string().uuid().parse(req.query.sessionId);
 149 |     const session = sessions.get(id);
 150 |     if (!session || session.actor.id !== actor.id) throw new ServiceError(404, 'SESSION_NOT_FOUND');
 151 |     if (Date.now() - session.touched > (options.sessionIdleMs ?? 900_000)) { await session.server.close(); sessions.delete(id); throw new ServiceError(404, 'SESSION_EXPIRED'); }
 152 |     session.touched = Date.now();
 153 |     await session.transport.handlePostMessage(req, res, req.body);
 154 |   }));
 155 |   const timer = setInterval(() => {
 156 |     for (const [id, session] of sessions) if (Date.now() - session.touched > (options.sessionIdleMs ?? 900_000)) { sessions.delete(id); void session.server.close(); }
 157 |   }, Math.min(options.sessionIdleMs ?? 900_000, 30_000));
 158 |   timer.unref();
 159 |   app.use((error: {type?: string}, _req: Request, res: Response, _next: NextFunction) => fail(res, error.type === 'entity.too.large' ? new ServiceError(413, 'BODY_TOO_LARGE') : error instanceof SyntaxError ? new ServiceError(400, 'INVALID_JSON') : error));
 160 |   return { app, close: async () => { stopping = true; clearInterval(timer); await Promise.allSettled([...sessions.values()].map(s => s.server.close())); sessions.clear(); await Promise.allSettled([options.law.close(),options.sources?.close()]); } };
 161 | }
 162 |
```

## tests/mcp-client.test.mjs
SHA256: 9ca4f1c06128abbe9d76a1aae9ffa7968c497857cb67a4353a264150bcb6608d
```text
   1 | import assert from 'node:assert/strict';
   2 | import test from 'node:test';
   3 | import { fileURLToPath } from 'node:url';
   4 | import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
   5 | import { basename, dirname, join } from 'node:path';
   6 | import { tmpdir } from 'node:os';
   7 | import { KoreanLawClient, koreanLawOptionsFromEnv } from '../dist/koreanLawClient.js';
   8 |
   9 | const fixturePath = fileURLToPath(new URL('./fixtures/law-mcp-server.mjs', import.meta.url));
  10 | function fixture(t, changes = {}) {
  11 |   const options = koreanLawOptionsFromEnv({
  12 |     LAW_OC: 'fixture-only',
  13 |     KOREAN_LAW_MCP_COMMAND: process.execPath,
  14 |     KOREAN_LAW_MCP_ARGS: JSON.stringify([fixturePath]),
  15 |   });
  16 |   const client = new KoreanLawClient({ ...options, ...changes });
  17 |   t.after(() => client.close());
  18 |   return client;
  19 | }
  20 |
  21 | test('real stdio handshake, paginated discovery and concurrent calls share one child', async t => {
  22 |   const client = fixture(t);
  23 |   const results = await Promise.all(Array.from({ length: 3 }, (_, index) => client.callTool('search_law', { query: String(index) })));
  24 |   assert.equal(new Set(results.map(result => result.result.structuredContent.pid)).size, 1);
  25 |   assert.deepEqual(results.map(result => result.result.structuredContent.callNumber).sort(), [1, 2, 3]);
  26 |   for (const result of results) {
  27 |     assert.equal(result.result.structuredContent.lists, 2);
  28 |     assert.equal(result.result.content[1].uri, 'https://www.law.go.kr/법령/소득세법');
  29 |     assert.equal(result.result.structuredContent.effectiveDate, '20250101');
  30 |     assert.deepEqual(result.result._meta, { fixture: true });
  31 |     assert.equal(result.server.name, 'law-fixture');
  32 |     assert.ok(Number.isFinite(Date.parse(result.retrieved_at)));
  33 |   }
  34 | });
  35 |
  36 | test('tool errors and invalid arguments remain failures without breaking a healthy child', async t => {
  37 |   const client = fixture(t);
  38 |   const first = await client.callTool('search_law', { query: 'ok' });
  39 |   await assert.rejects(client.callTool('search_law', { query: '__error__' }), error =>
  40 |     error.status === 502 && error.code === 'MCP_TOOL_ERROR' && error.result.isError === true);
  41 |   await assert.rejects(client.callTool('search_law', { query: '__invalid__' }), error => error.status === 400);
  42 |   await assert.rejects(client.callTool('not_advertised', {}), error => error.code === 'MCP_UNKNOWN_TOOL');
  43 |   const next = await client.callTool('search_law', { query: 'ok' });
  44 |   assert.equal(first.result.structuredContent.pid, next.result.structuredContent.pid);
  45 | });
  46 |
  47 | test('tool timeout retires the old child and the next request reconnects', async t => {
  48 |   const client = fixture(t, { requestTimeoutMs: 100 });
  49 |   await client.listTools();
  50 |   const first = await client.callTool('search_law', { query: 'ok' });
  51 |   const oldPid = first.result.structuredContent.pid;
  52 |   await assert.rejects(client.callTool('search_law', { query: '__hang__' }), error => error.status === 504);
  53 |   assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
  54 |   await client.listTools();
  55 |   const next = await client.callTool('search_law', { query: 'ok' });
  56 |   assert.notEqual(next.result.structuredContent.pid, oldPid);
  57 | });
  58 | test('cold child connection consumes the total retrieval budget; warm calls retain the remaining budget',async t=>{
  59 |   const options=koreanLawOptionsFromEnv({LAW_OC:'fixture',KOREAN_LAW_MCP_COMMAND:process.execPath,KOREAN_LAW_MCP_ARGS:JSON.stringify([fixturePath,'--start-delay=600'])});
  60 |   const client=fixture(t,{...options,requestTimeoutMs:2000,connectTimeoutMs:2000});
  61 |   const started=Date.now();
  62 |   await assert.rejects(client.callTool('search_law',{query:'__budget_slow__'}),e=>e.code==='MCP_TIMEOUT');
  63 |   assert.ok(Date.now()-started<6500,'slot includes bounded child cleanup');
  64 |   await client.listTools();assert.equal((await client.callTool('search_law',{query:'__budget_slow__'})).kind,'retrieval');
  65 |   assert.throws(()=>koreanLawOptionsFromEnv({KOREAN_LAW_MCP_TIMEOUT_MS:'45001'}));
  66 | });
  67 | test('expiration while waiting for retirement retains capacity and cannot spawn an orphan child',async t=>{
  68 |   const directory=await mkdtemp(join(tmpdir(),'legal-harness-retirement-'));
  69 |   const log=join(directory,'lifecycle.log');await writeFile(log,'');
  70 |   const options=koreanLawOptionsFromEnv({LAW_OC:'fixture',KOREAN_LAW_MCP_COMMAND:process.execPath,KOREAN_LAW_MCP_ARGS:JSON.stringify([fixturePath,'--linger-after-eof','--lifecycle-log='+log])});
  71 |   const client=fixture(t,{...options,requestTimeoutMs:100,maxConcurrentCalls:2});
  72 |   t.after(async()=>{const target=await realpath(directory);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('legal-harness-retirement-'));await rm(target,{recursive:true,force:true});});
  73 |   await client.listTools();
  74 |   const first=assert.rejects(client.callTool('search_law',{query:'__hang__'}),e=>e.code==='MCP_TIMEOUT');
  75 |   const until=Date.now()+4000;
  76 |   while(!(await readFile(log,'utf8')).includes('eof:')) {assert.ok(Date.now()<until,'child entered actual SDK shutdown');await new Promise(r=>setTimeout(r,20));}
  77 |   let secondSettled=false;
  78 |   const second=assert.rejects(client.callTool('search_law',{query:'ok'}),e=>e.code==='MCP_TIMEOUT').finally(()=>{secondSettled=true;});
  79 |   try {
  80 |     await new Promise(r=>setTimeout(r,250));
  81 |     assert.equal(secondSettled,false,'the expired waiter still owns its slot until cleanup completes');
  82 |     await assert.rejects(client.callTool('search_law',{query:'excess'}),e=>e.code==='MCP_AT_CAPACITY');
  83 |   } finally {await Promise.all([first,second]);}
  84 |   await new Promise(r=>setTimeout(r,250));
  85 |   assert.equal((await readFile(log,'utf8')).match(/^start:/gm)?.length,1,'no child starts without a new live request');
  86 |   await client.listTools();assert.equal((await client.callTool('search_law',{query:'ok'})).kind,'retrieval');
  87 |   assert.equal((await readFile(log,'utf8')).match(/^start:/gm)?.length,2);
  88 | });
  89 |
  90 | test('a crashed child is reported as failure and does not poison later requests', async t => {
  91 |   const client = fixture(t);
  92 |   await assert.rejects(client.callTool('search_law', { query: '__crash__' }), error => error.status === 502);
  93 |   const next = await client.callTool('search_law', { query: 'ok' });
  94 |   assert.equal(next.result.structuredContent.callNumber, 1);
  95 | });
  96 |
  97 | test('MCP capacity remains bounded independently of HTTP connection lifetime', async t => {
  98 |   const client = fixture(t);
  99 |   const requests = Array.from({ length: 3 }, () => client.callTool('search_law', { query: '__slow__' }));
 100 |   try {
 101 |     await assert.rejects(client.callTool('search_law', { query: 'excess' }), error => error.status === 429);
 102 |   } finally {
 103 |     await Promise.all(requests);
 104 |   }
 105 |   assert.equal((await client.callTool('search_law', { query: 'ok' })).result.structuredContent.callNumber, 4);
 106 | });
 107 |
 108 | test('missing executable and stalled initialization fail within the startup deadline', async t => {
 109 |   const options = koreanLawOptionsFromEnv({ LAW_OC: 'fixture' });
 110 |   const missing = fixture(t, { server: { ...options.server, command: 'missing-legal-harness-test-executable' } });
 111 |   await assert.rejects(missing.listTools(), error => error.status === 503);
 112 |   const stalled = fixture(t, {
 113 |     server: { ...options.server, command: process.execPath, args: [fixturePath, '--hang-start'] },
 114 |     connectTimeoutMs: 100,
 115 |   });
 116 |   const started = Date.now();
 117 |   await assert.rejects(stalled.listTools(), error => error.status === 503);
 118 |   assert.ok(Date.now() - started < 6000);
 119 | });
 120 |
 121 | test('closing the client reaps its child and prevents accidental respawn', async t => {
 122 |   const client = fixture(t);
 123 |   const result = await client.callTool('search_law', { query: 'ok' });
 124 |   await client.close();
 125 |   assert.throws(() => process.kill(result.result.structuredContent.pid, 0), { code: 'ESRCH' });
 126 |   await assert.rejects(client.listTools(), error => error.code === 'MCP_CLOSED');
 127 | });
 128 |
 129 | test('only explicit law settings reach the child, and absent LAW_OC cannot produce legal data', async t => {
 130 |   const keys = ['SUPABASE_ANON_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS'];
 131 |   const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
 132 |   t.after(() => {
 133 |     for (const key of keys) {
 134 |       if (before[key] === undefined) delete process.env[key];
 135 |       else process.env[key] = before[key];
 136 |     }
 137 |   });
 138 |   process.env.SUPABASE_ANON_KEY = 'must-not-inherit';
 139 |   process.env.GITHUB_TOKEN = 'must-not-inherit';
 140 |   process.env.NODE_OPTIONS = '--stack-trace-limit=2';
 141 |   const client = fixture(t);
 142 |   const result = await client.callTool('search_law', { query: 'ok' });
 143 |   assert.equal(result.result.structuredContent.inheritedSecrets, false);
 144 |   assert.equal(result.result.structuredContent.hasLawKey, true);
 145 |   const noKey = new KoreanLawClient(koreanLawOptionsFromEnv({}));
 146 |   t.after(() => noKey.close());
 147 |   await assert.rejects(noKey.callTool('search_law', { query: 'ok' }), error => error.code === 'MCP_NOT_CONFIGURED');
 148 | });
 149 |
 150 | test('installed korean-law-mcp release starts over stdio and advertises real tool schemas without API calls', async t => {
 151 |   const client = new KoreanLawClient(koreanLawOptionsFromEnv({}));
 152 |   t.after(() => client.close());
 153 |   const catalog = await client.listTools();
 154 |   assert.equal(catalog.server.name, 'korean-law');
 155 |   for (const name of ['legal_research', 'search_law', 'get_law_text', 'search_decisions', 'get_decision_text']) {
 156 |     assert.ok(catalog.tools.some(tool => tool.name === name && tool.inputSchema.type === 'object'), name);
 157 |   }
 158 | });
 159 |
 160 | test('deployment release file selects the verified upstream executable and rejects conflicting manual settings', async t => {
 161 |   const directory = await mkdtemp(join(tmpdir(), 'legal-harness-release-'));
 162 |   t.after(async () => {
 163 |     const target = await realpath(directory);
 164 |     assert.equal(dirname(target), await realpath(tmpdir()));
 165 |     assert.ok(basename(target).startsWith('legal-harness-release-'));
 166 |     await rm(target, { recursive: true, force: true });
 167 |   });
 168 |   const entrypoint = fileURLToPath(import.meta.resolve('korean-law-mcp'));
 169 |   const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('korean-law-mcp')), 'utf8'));
 170 |   const releaseFile = join(directory, 'active.json');
 171 |   await writeFile(releaseFile, JSON.stringify({ version: metadata.version, entrypoint }));
 172 |   const env = { KOREAN_LAW_MCP_RELEASE_FILE: releaseFile };
 173 |   const options = koreanLawOptionsFromEnv(env);
 174 |   assert.equal(options.server.args[0], entrypoint);
 175 |   assert.equal(options.releaseVersion, metadata.version);
 176 |   assert.throws(() => koreanLawOptionsFromEnv({ ...env, KOREAN_LAW_MCP_ARGS: '[]' }), /not both/);
 177 |   const client = new KoreanLawClient(options);
 178 |   t.after(() => client.close());
 179 |   assert.equal((await client.listTools()).server.version, metadata.version);
 180 | });
 181 |
 182 | test('a process whose version differs from its release manifest cannot initialize successfully', async t => {
 183 |   const client = fixture(t, { releaseVersion: '9.9.9' });
 184 |   await assert.rejects(client.listTools(), error => error.code === 'MCP_UNAVAILABLE');
 185 | });
 186 |
```

## tests/fixtures/law-mcp-server.mjs
SHA256: 4c5f25cf14aa42f5db170930a3cb83fe69f742ed67d4b4d41a8e3394f05b5e55
```text
   1 | // A real JSON-RPC stdio peer. It never calls any external network service.
   2 | import { Server } from '@modelcontextprotocol/sdk/server/index.js';
   3 | import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
   4 | import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
   5 | import { appendFileSync } from 'node:fs';
   6 |
   7 | const lifecycleLog=process.argv.find(a=>a.startsWith('--lifecycle-log='))?.slice('--lifecycle-log='.length);
   8 | if(lifecycleLog) {
   9 |   appendFileSync(lifecycleLog,`start:${process.pid}\n`);
  10 |   process.stdin.on('end',()=>appendFileSync(lifecycleLog,`eof:${process.pid}\n`));
  11 | }
  12 | if(process.argv.includes('--linger-after-eof'))setInterval(()=>{},1000);
  13 |
  14 | if (process.argv.includes('--hang-start')) {
  15 |   setInterval(() => {}, 1000);
  16 | } else {
  17 |   const startDelay=process.argv.find(a=>a.startsWith('--start-delay='));
  18 |   if(startDelay)await new Promise(r=>setTimeout(r,Number(startDelay.split('=')[1])));
  19 |   const server = new Server({ name: 'law-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  20 |   let lists = 0;
  21 |   let calls = 0;
  22 |   server.setRequestHandler(ListToolsRequestSchema, async request => {
  23 |     lists++;
  24 |     const names = request.params?.cursor === 'second' ? ['search_law'] : ['legal_research', 'get_law_text'];
  25 |     return {
  26 |       tools: names.map(name => ({ name, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } })),
  27 |       ...(request.params?.cursor ? {} : { nextCursor: 'second' }),
  28 |     };
  29 |   });
  30 |   server.setRequestHandler(CallToolRequestSchema, async request => {
  31 |     const callNumber = ++calls;
  32 |     const args = request.params.arguments ?? {};
  33 |     if (args.query === '__crash__') process.exit(12);
  34 |     if (args.query === '__hang__') return new Promise(() => {});
  35 |     if (args.query === '__invalid__') throw new McpError(ErrorCode.InvalidParams, 'Fixture invalid args');
  36 |     if (args.query === '__error__') return { isError: true, content: [{ type: 'text', text: 'Fixture upstream failure' }] };
  37 |     if (args.query === '__slow__') await new Promise(resolve => setTimeout(resolve, 250));
  38 |     if (args.query === '__budget_slow__') await new Promise(resolve => setTimeout(resolve, 1500));
  39 |     return {
  40 |       content: [{ type: 'text', text: '법령 조회 fixture' }, {
  41 |         type: 'resource_link', name: '소득세법 fixture', uri: 'https://www.law.go.kr/법령/소득세법',
  42 |       }],
  43 |       structuredContent: {
  44 |         pid: process.pid, lists, callNumber, args,
  45 |         effectiveDate: '20250101',
  46 |         inheritedSecrets: Boolean(process.env.SUPABASE_ANON_KEY || process.env.GITHUB_TOKEN || process.env.NODE_OPTIONS),
  47 |         hasLawKey: Boolean(process.env.LAW_OC),
  48 |       },
  49 |       _meta: { fixture: true },
  50 |     };
  51 |   });
  52 |   await server.connect(new StdioServerTransport());
  53 | }
  54 |
```

## tests/review-regressions.test.mjs
SHA256: a4db4d9c74d7f7f46a6a8a68540cfbf2f9aeca32ba87626abeda85f2e3315f6b
```text
   1 | ﻿import assert from 'node:assert/strict';
   2 | import test from 'node:test';
   3 | import { createServer } from 'node:http';
   4 | import { Client } from '@modelcontextprotocol/sdk/client/index.js';
   5 | import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
   6 | import { createApp } from '../dist/app.js';
   7 | import { createAuthenticator } from '../dist/auth.js';
   8 | import { GateEngine } from '../dist/gates.js';
   9 | import { LawMcpError } from '../dist/koreanLawClient.js';
  10 | import { ServiceError, digest } from '../dist/contracts.js';
  11 | import { safeToolDiagnostic } from '../dist/errorDiagnostics.js';
  12 |
  13 | async function fixture(t, opts = {}) {
  14 |   const calls = [];
  15 |   const law = { releaseVersion: '4.13.0', listTools: async () => ({tools: [{name:'search_law',inputSchema:{type:'object'}}]}), close: async () => {},
  16 |     callTool: async (name,args) => { calls.push({name,args}); if(opts.operation) await opts.operation(); if(opts.error) throw opts.error;
  17 |       return {kind:'retrieval',tool:name,result:{content:[{type:'text',text:'Fixture source'}], structuredContent:{law:'fixture'}, _meta:{upstream:'preserved'}}}; } };
  18 |   const authenticate = opts.realAuth ? createAuthenticator({TAXLAB_API_KEY: 'fixture-key'}) : async req => {
  19 |     if (req.query.apiKey !== undefined || !['Bearer alice','Bearer bob'].includes(req.get('authorization'))) throw new ServiceError(401,'UNAUTHORIZED');
  20 |     return {id:req.get('authorization').slice(7),kind:'auth_user',userId:req.get('authorization').slice(7)};
  21 |   };
  22 |   const runtime = createApp({law,authenticate,...opts});
  23 |   const server = createServer(runtime.app);
  24 |   await new Promise(r => server.listen(0,'127.0.0.1',r));
  25 |   const base = 'http://127.0.0.1:' + server.address().port;
  26 |   t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  27 |   async function request(path,body,auth='Bearer alice',extra={}) {
  28 |     const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(auth?{authorization:auth}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(4000)});
  29 |     return {status:res.status,body:await res.json()};
  30 |   }
  31 |   return {base,calls,request,runtime};
  32 | }
  33 |
  34 | test('native ESM app imports without starting a listener or loading environment credentials',()=>assert.equal(typeof createApp,'function'));
  35 | test('unauthenticated analyze/tools/messages do no upstream work',async t=>{
  36 |   const f=await fixture(t);
  37 |   for(const [p,b] of [['/api/analyze',{query:'law'}],['/api/tools',undefined],['/messages?sessionId=00000000-0000-4000-8000-000000000001',{}]]) assert.equal((await f.request(p,b,null)).status,401);
  38 |   assert.equal(f.calls.length,0);
  39 | });
  40 | test('production authentication rejects query keys and missing key configuration',async t=>{
  41 |   const f=await fixture(t,{realAuth:true});
  42 |   assert.equal((await f.request('/api/tools?apiKey=fixture-key',undefined,null)).status,401);
  43 |   assert.equal((await f.request('/api/tools',undefined,'Bearer fixture-key')).status,200);
  44 |   const noKey=createAuthenticator({});
  45 |   await assert.rejects(noKey({query:{},get:n=>n==='x-api-key'?'fixture-key':undefined}),e=>e.status===401);
  46 | });
  47 | test('JWT identity is verified through Supabase and never comes from submitted names',async()=>{
  48 |   let observed;
  49 |   const auth=createAuthenticator({SUPABASE_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-publishable'},async(input,init)=>{
  50 |     observed=new Request(input,init);return Response.json({id:'00000000-0000-4000-8000-000000000001'});
  51 |   });
  52 |   const actor=await auth({query:{},get:n=>n==='authorization'?'Bearer fixture-jwt':undefined});
  53 |   assert.equal(observed.headers.get('authorization'),'Bearer fixture-jwt');
  54 |   assert.equal(actor.id,'user:00000000-0000-4000-8000-000000000001');
  55 | });
  56 | test('global execution capacity counts work until completion including disconnected callers',async t=>{
  57 |   let entered=0;const wait=Promise.withResolvers();
  58 |   const f=await fixture(t,{operation:async()=>{entered++;await wait.promise;}});
  59 |   const controller=new AbortController();
  60 |   const disconnected=fetch(f.base+'/api/analyze',{method:'POST',headers:{authorization:'Bearer alice','content-type':'application/json'},body:JSON.stringify({query:'law'}),signal:controller.signal}).catch(()=>null);
  61 |   const requests=[1,2].map(()=>f.request('/api/analyze',{query:'law'}));
  62 |   while(entered<3) await new Promise(r=>setTimeout(r,5));
  63 |   controller.abort();await disconnected;
  64 |   assert.equal((await f.request('/api/analyze',{query:'law'})).status,429);
  65 |   wait.resolve();await Promise.all(requests);
  66 |   assert.equal((await f.request('/health')).body.active_requests,0);
  67 | });
  68 | test('retrieval retains structured content and provenance without pretending to validate a final answer',async t=>{
  69 |   const f=await fixture(t);const r=await f.request('/api/analyze',{query:'law'});
  70 |   assert.equal(r.status,200);assert.equal(f.calls[0].name,'legal_research');assert.equal(f.calls[0].args.query,'law');
  71 |   assert.equal(r.body.data.result.structuredContent.law,'fixture');assert.equal(r.body.quality_gate,null);
  72 |   assert.equal(r.body.data.evidence.applicability,'unverified');assert.equal(r.body.data.evidence.purpose,'retrieval_only');
  73 | });
  74 | test('explicit retrieval identifiers are not overwritten; invalid process settings/query rejected',async t=>{
  75 |   const f=await fixture(t);await f.request('/api/analyze',{query:'law',tool:'get_law_text',arguments:{mst:'123',jo:'88'}});
  76 |   assert.deepEqual(f.calls[0].args,{mst:'123',jo:'88'});
  77 |   assert.equal((await f.request('/api/analyze',{})).status,400);
  78 |   assert.equal((await f.request('/api/analyze',{query:'law',command:'bad'})).status,400);
  79 | });
  80 | test('upstream timeout/config/tool failures are failures and unexpected errors do not leak secrets',async t=>{
  81 |   for(const [status,code] of [[502,'MCP_TOOL_ERROR'],[503,'MCP_NOT_CONFIGURED'],[504,'MCP_TIMEOUT']]) {
  82 |     const f=await fixture(t,{error:new LawMcpError(status,code,'private-detail')});const r=await f.request('/api/analyze',{query:'law'});
  83 |     assert.equal(r.status,status);assert.equal(r.body.code,code);assert.ok(!JSON.stringify(r).includes('private-detail'));
  84 |   }
  85 |   const f=await fixture(t,{error:new Error('private-token')});assert.deepEqual((await f.request('/api/analyze',{query:'law'})).body,{code:'INTERNAL_ERROR'});
  86 | });
  87 | test('expected tool diagnostics survive REST and MCP while configured secrets and internal fields are removed',async t=>{
  88 |   const secret='fixture-law-secret-value';
  89 |   const encodedDiagnostic='{"required":["event_date"],"headers":{"x-private":"unknown-private"},"detail":"\\u0066ixture-law-secret-value"}';
  90 |   const diagnostic={isError:true,content:[{type:'text',text:`PUBLIC_SYNTHETIC_EVENT_DATE_REQUIRED https://source.invalid?OC=${secret}`},{type:'text',text:encodedDiagnostic}],structuredContent:{required:['event_date'],headers:{authorization:secret},stack:secret,detail:'safe public fixture'},_meta:{token:secret}};
  91 |   const f=await fixture(t,{env:{LAW_OC:secret},error:new LawMcpError(502,'MCP_TOOL_ERROR','exception message must remain private',diagnostic)});
  92 |   const rest=await f.request('/api/analyze',{query:'fixture'});assert.equal(rest.status,502);assert.deepEqual(rest.body.result.structuredContent.required,['event_date']);assert.match(rest.body.result.content[0].text,/PUBLIC_SYNTHETIC/);
  93 |   assert.ok(!JSON.stringify(rest).includes(secret));assert.ok(!JSON.stringify(rest).includes('exception message'));
  94 |   assert.deepEqual(JSON.parse(rest.body.result.content[1].text),{required:['event_date'],detail:'[REDACTED]'});
  95 |   const client=new Client({name:'error-contract',version:'1'});t.after(()=>client.close());
  96 |   await client.connect(new SSEClientTransport(new URL(f.base+'/sse'),{requestInit:{headers:{authorization:'Bearer alice'}}}),{timeout:3000});
  97 |   const mcp=await client.callTool({name:'search_law',arguments:{query:'fixture'}});assert.equal(mcp.isError,true);assert.deepEqual(mcp.structuredContent.required,['event_date']);assert.match(mcp.content[0].text,/PUBLIC_SYNTHETIC/);assert.ok(!JSON.stringify(mcp).includes(secret));assert.equal(mcp.structuredContent.stack,undefined);
  98 |   assert.deepEqual(JSON.parse(mcp.content[1].text),{required:['event_date'],detail:'[REDACTED]'});
  99 | });
 100 | test('tool diagnostics bound oversized data and omit credential labels and internal traces',()=>{
 101 |   const result=safeToolDiagnostic({isError:true,content:[{type:'text',text:'PUBLIC_FIXTURE\nAuthorization: Bearer fixture-unknown-value\n    at /internal/private.js:10\nSUPABASE_SECRET=unconfigured-sensitive-value'}],structuredContent:{required:['event_date'],environment:{secret:'hidden'},large:'z'.repeat(20000)}},{});
 102 |   const json=JSON.stringify(result);assert.ok(json.includes('PUBLIC_FIXTURE'));assert.ok(!json.includes('fixture-unknown-value'));assert.ok(!json.includes('unconfigured-sensitive-value'));assert.ok(!json.includes('/internal/private.js'));assert.ok(Buffer.byteLength(json)<=16000);
 103 | });
 104 | test('JSON tool diagnostics decode before filtering nested private fields and escaped configured secrets',()=>{
 105 |   const secret='fixture-"law\\secret\nvalue';
 106 |   const encoded=JSON.stringify(secret).slice(1,-1).replace('f','\\u0066');
 107 |   const text=`{"code":"PUBLIC_ARGUMENT_REQUIRED","required":["event_date"],"headers":{"x-private":"unknown-credential"},"stack":"internal-trace","detail":"${encoded}"}`;
 108 |   const result=safeToolDiagnostic({isError:true,content:[{type:'text',text}],structuredContent:{nested:JSON.stringify({required:['event_date'],environment:{private:'unknown-environment'},detail:secret})}},{LAW_OC:secret});
 109 |   const parsed=JSON.parse(result.content[0].text);
 110 |   assert.equal(parsed.code,'PUBLIC_ARGUMENT_REQUIRED');assert.deepEqual(parsed.required,['event_date']);
 111 |   assert.equal(parsed.headers,undefined);assert.equal(parsed.stack,undefined);assert.equal(parsed.detail,'[REDACTED]');
 112 |   const nested=JSON.parse(result.structuredContent.nested);
 113 |   assert.deepEqual(nested.required,['event_date']);assert.equal(nested.environment,undefined);assert.equal(nested.detail,'[REDACTED]');
 114 |   const mixed=safeToolDiagnostic({isError:true,content:[{type:'text',text:'Source failure: '+text}]},{LAW_OC:secret});
 115 |   assert.ok(!JSON.stringify(mixed).includes('unknown-credential'));
 116 | });
 117 | test('numeric credentials and serialized traces never enter public tool diagnostics',()=>{
 118 |   const result=safeToolDiagnostic({isError:true,content:[{type:'text',text:JSON.stringify({required:['event_date'],stack:'Error: fixture\n at /internal/private.js:10:20'})}],structuredContent:{LAW_OC:123456789,detail:123456789,required:['event_date']}},{LAW_OC:'123456789'});
 119 |   assert.deepEqual(JSON.parse(result.content[0].text),{required:['event_date']});
 120 |   assert.equal(result.structuredContent.LAW_OC,undefined);assert.equal(result.structuredContent.detail,'[REDACTED]');
 121 | });
 122 | test('legacy automatic PR paths stay closed and unavailable durable intake never reports success',async t=>{
 123 |   const f=await fixture(t);
 124 |   assert.equal((await f.request('/api/evolve',{issue_summary:'old'})).status,410);
 125 |   assert.equal((await f.request('/api/failures',{})).status,503);
 126 | });
 127 | test('durable service receives verified actor and DB error is not success',async t=>{
 128 |   let actor;const f=await fixture(t,{failures:{submit:async(a)=>{actor=a;throw new ServiceError(503,'DB_UNAVAILABLE');},status:async()=>({})}});
 129 |   assert.equal((await f.request('/api/failures',{proposer_name:'bob'})).status,503);assert.equal(actor.id,'alice');
 130 | });
 131 | test('real MCP SSE and messages require matching authenticated principal, preserve upstream result',async t=>{
 132 |   const f=await fixture(t);let session;
 133 |   const client=new Client({name:'review',version:'1'});
 134 |   const transport=new SSEClientTransport(new URL(f.base+'/sse'),{requestInit:{headers:{authorization:'Bearer alice'}},fetch:async(url,init)=>{
 135 |     if(String(url).includes('/messages?')) session=new URL(url).searchParams.get('sessionId');return fetch(url,init);
 136 |   }});
 137 |   t.after(()=>client.close());await client.connect(transport,{timeout:3000});
 138 |   const catalog=await client.listTools();assert.ok(catalog.tools.some(x=>x.name==='validate_legal_draft'));
 139 |   assert.equal((await f.request('/messages?sessionId='+session,{jsonrpc:'2.0',method:'ping',id:20},'Bearer bob')).status,404);
 140 |   const r=await client.callTool({name:'search_law',arguments:{query:'law'}});assert.equal(r.structuredContent.law,'fixture');assert.equal(r._meta.upstream,'preserved');
 141 |   const invalid=await client.callTool({name:'validate_tax_draft',arguments:{draft_answer:'law',force:'false'}});assert.equal(invalid.isError,true);
 142 |   const old=await client.callTool({name:'propose_tax_rule',arguments:{}});assert.equal(old.isError,true);
 143 | });
 144 | test('foreign browser Origin and oversized body are rejected',async t=>{
 145 |   const f=await fixture(t);assert.equal((await f.request('/api/tools',undefined,'Bearer alice',{origin:'https://evil.invalid'})).status,403);
 146 |   assert.equal((await f.request('/api/analyze',{query:'x'.repeat(300000)})).status,413);
 147 | });
 148 | test('all ten rules have executable missing-fact paths; FC08-10 are no longer silent passes',()=>{
 149 |   const engine=new GateEngine();assert.equal(engine.rules.length,10);
 150 |   for(const rule of engine.rules){const r=engine.validate({draft_answer:rule.cues[0]},'fixture');assert.equal(r.checks.find(x=>x.id===rule.id).status,'needs_info');assert.equal(r.passed,false);}
 151 |   const result=engine.validate({draft_answer:'종전 취득원가 권리가액 분담금 전액을 시가로 안분'},'fixture');
 152 |   assert.ok(['FC-08','FC-09','FC-10'].every(id=>result.checks.some(c=>c.case_id===id)));
 153 | });
 154 | test('empty checks/skips/unverified legal basis cannot become passed; force preserves completed failed arithmetic',()=>{
 155 |   const e=new GateEngine();assert.equal(e.validate({draft_answer:'hello'},'v').coverage,'no_coverage');
 156 |   assert.throws(()=>e.validate({draft_answer:''},'v'));assert.throws(()=>new GateEngine('missing-rules-directory'));
 157 |   const normal=e.validate({draft_answer:'arithmetic',facts:{allocation:{total:100,parts:[60,60]}}},'v');assert.equal(normal.blocked,true);assert.equal(normal.assessment_complete,true);
 158 |   const forced=e.validate({draft_answer:'arithmetic',facts:{allocation:{total:100,parts:[60,60]}},force:true,bypass_reason:'review exception'},'v');
 159 |   assert.equal(forced.blocked,false);assert.equal(forced.assessment_complete,true);assert.equal(forced.scoped_pass,false);assert.equal(forced.passed,false);
 160 |   const skipped=e.validate({draft_answer:'분담금',skip_gates:['QG-COST-03'],bypass_reason:'review exception'},'v');assert.equal(skipped.assessment_complete,false);
 161 |   const unrelatedSkip=e.validate({draft_answer:'arithmetic',facts:{allocation:{total:100,parts:[60,60]}},skip_gates:['QG-COST-03'],bypass_reason:'skip only contribution research'},'v');
 162 |   assert.equal(unrelatedSkip.blocked,true,'skipping a legal research question cannot disable an executed arithmetic failure');assert.equal(unrelatedSkip.scoped_pass,false);
 163 |   const revised=e.validate({draft_answer:'different'},'v');assert.notEqual(normal.draft_hash,revised.draft_hash);
 164 |   const exact='  original draft  \n';assert.equal(e.validate({draft_answer:exact},'v').draft_hash,digest(exact));
 165 |   assert.notEqual(e.validate({draft_answer:exact},'v').draft_hash,e.validate({draft_answer:exact.trim()},'v').draft_hash);
 166 |   assert.throws(()=>e.validate({draft_answer:'   \n'},'v'));
 167 | });
 168 | test('health records release and rule fingerprints',async t=>{const f=await fixture(t);const r=await f.request('/health');assert.equal(r.body.mcp_release,'4.13.0');assert.match(r.body.rules_version,/^[a-f0-9]{64}$/);});
 169 |
```
