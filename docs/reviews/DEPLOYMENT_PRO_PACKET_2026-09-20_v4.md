# Final bounded follow-up: A-1 only

Immutable code commit: e7ce0b2214c94dae1f3f2e96281b045635ddb4c5

The only runtime change since 1fb66e176dba757452899db3fc21a8c5f8ce61dd is the pre-acquisition deadline guard: it now throws LawMcpError(504, MCP_TIMEOUT) so the existing LawMcpError catch path does not retire a different request's new connection. The retirement and acquisition wait for an actual timer timeout is unchanged. No other runtime changes were made. R1-R3 and B are outside this follow-up because your prior reviews resolved them.

The new regression controls the previous retirement promise and event-loop ordering only; the new child uses the REAL installed SDK/stdio fixture. E starts with a 3000ms budget; N starts 2100ms later; a 1100ms Atomics.wait delays timer callbacks. Releasing retirement schedules the acquisition microtasks with E expired and N still valid. Before the guard fix, N failed with MCP_UNAVAILABLE. After the fix N retrieves successfully. Previous real subprocess EOF/cleanup/capacity/no-orphan coverage remains in the same file. The synthetic prior-retirement boundary is not claimed to be a complete operating-system cleanup reproduction.

Validation by implementer: final npm run review 68/68 pass, zero fail/skip/cancel/todo, 32242.7682ms. The preceding full run had 67 pass/1 failure in the unchanged installed-upstream handshake test at the existing 10s deadline. With NO code or timeout change, an isolated rerun passed in 1.7s, followed by the full 68/68 run. The underlying intermittent-startup cause is not asserted. Linux CI and production cold-start validation remain pending.

Final package evidence (local clean install + real local SDK/transport fixture; not a live endpoint check):
```json
{
  "status": "pass",
  "artifact": "k-tax-agent-backend-2.2.0.tgz",
  "sha256": "08fe3e6d24a22d1d68e4db278b29d43d96f627339999a897423114b0a2cf7f61",
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
  "reviewed_commit": "e7ce0b2214c94dae1f3f2e96281b045635ddb4c5"
}
```

Production deployment remains HOLD: Linux CI, HTTPS/DNS/tunnel, public TCP 3000 closure, safe rollback and final human batch approval have not occurred. The automatic worker/publisher/activator remain disconnected. No merge, deployment or DB migration was performed. The Draft PR is #3.

## Exact runtime/test diff since prior reviewed snapshot
```diff
diff --git a/src/koreanLawClient.ts b/src/koreanLawClient.ts
index 245e4e0..bc01017 100644
--- a/src/koreanLawClient.ts
+++ b/src/koreanLawClient.ts
@@ -111,7 +111,9 @@ export class KoreanLawClient {
     await this.retiring;
     // A caller can expire while the previous child is being reaped. Never
     // create (or join) a new connection on behalf of that expired caller.
-    if (Date.now() >= deadline) throw new McpError(ErrorCode.RequestTimeout, 'Legal retrieval deadline exceeded');
+    // No connection has been acquired here. Use the pre-acquisition error
+    // path, which must not retire another caller's newly created connection.
+    if (Date.now() >= deadline) throw new LawMcpError(504, 'MCP_TIMEOUT', 'Legal retrieval expired before acquiring a connection.');
     if (this.stopped) throw new LawMcpError(503, "MCP_CLOSED", "The legal MCP client is shutting down.");
     if (this.connecting) return this.connecting;
     if (this.connection?.ready) return this.connection;
diff --git a/tests/mcp-client.test.mjs b/tests/mcp-client.test.mjs
index 3d19695..af5faa0 100644
--- a/tests/mcp-client.test.mjs
+++ b/tests/mcp-client.test.mjs
@@ -86,6 +86,22 @@ test('expiration while waiting for retirement retains capacity and cannot spawn
   await client.listTools();assert.equal((await client.callTool('search_law',{query:'ok'})).kind,'retrieval');
   assert.equal((await readFile(log,'utf8')).match(/^start:/gm)?.length,2);
 });
+test('an expired acquisition cannot retire another request that is still starting within its deadline',async t=>{
+  const client=fixture(t,{requestTimeoutMs:3000});
+  let finishRetirement;
+  // Control only the prior retirement boundary. The new child still uses the
+  // real SDK/stdio fixture, and both calls execute the production client code.
+  client.retiring=new Promise(resolve=>{finishRetirement=resolve;});
+  const expired=assert.rejects(client.callTool('search_law',{query:'expired'}),error=>error.code==='MCP_TIMEOUT');
+  await new Promise(resolve=>setTimeout(resolve,2100));
+  const live=client.callTool('search_law',{query:'live'});
+  // Delay timer callbacks so retirement microtasks run with E expired and N
+  // still valid. This reproduces the reported event-loop ordering explicitly.
+  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);
+  finishRetirement();
+  const [,result]=await Promise.all([expired,live]);
+  assert.equal(result.kind,'retrieval');assert.equal(result.result.structuredContent.args.query,'live');
+});
 
 test('a crashed child is reported as failure and does not poison later requests', async t => {
   const client = fixture(t);

```

## src/koreanLawClient.ts
SHA256: 6b2971c6cbf06b94502136a1838719399d5c6c241cd869ad8e93ed2b98e59131
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
 114 |     // No connection has been acquired here. Use the pre-acquisition error
 115 |     // path, which must not retire another caller's newly created connection.
 116 |     if (Date.now() >= deadline) throw new LawMcpError(504, 'MCP_TIMEOUT', 'Legal retrieval expired before acquiring a connection.');
 117 |     if (this.stopped) throw new LawMcpError(503, "MCP_CLOSED", "The legal MCP client is shutting down.");
 118 |     if (this.connecting) return this.connecting;
 119 |     if (this.connection?.ready) return this.connection;
 120 |     const connecting = this.openConnection();
 121 |     this.connecting = connecting;
 122 |     try {
 123 |       return await connecting;
 124 |     } finally {
 125 |       if (this.connecting === connecting) this.connecting = undefined;
 126 |     }
 127 |   }
 128 |
 129 |   async listTools() {
 130 |     const connection = await this.getConnection();
 131 |     return { server: connection.client.getServerVersion(), tools: connection.tools };
 132 |   }
 133 |
 134 |   async callTool(name: string, args: Record<string, unknown>) {
 135 |     if (!this.options.server.env?.LAW_OC) {
 136 |       throw new LawMcpError(503, "MCP_NOT_CONFIGURED", "Set LAW_OC on the Express server before requesting legal data.");
 137 |     }
 138 |     // Keep this slot until work ends, even if the HTTP caller disconnects.
 139 |     if (this.activeCalls >= this.options.maxConcurrentCalls) {
 140 |       throw new LawMcpError(429, "MCP_AT_CAPACITY", "Legal retrieval is at capacity. Please retry later.");
 141 |     }
 142 |     this.activeCalls++;
 143 |     const deadline = Date.now() + this.options.requestTimeoutMs;
 144 |     let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
 145 |     const expired = new Promise<never>((_resolve, reject) => {
 146 |       deadlineTimer = setTimeout(() => reject(new McpError(ErrorCode.RequestTimeout, 'Legal retrieval deadline exceeded')), this.options.requestTimeoutMs);
 147 |     });
 148 |     let connection: Connection | undefined;
 149 |     let acquiring: Promise<Connection> | undefined;
 150 |     try {
 151 |       acquiring = this.getConnection(deadline);
 152 |       connection = await Promise.race([acquiring, expired]);
 153 |       if (!connection.tools.some(tool => tool.name === name)) {
 154 |         throw new LawMcpError(400, "MCP_UNKNOWN_TOOL", "Tool is not advertised by korean-law-mcp. See /api/tools.");
 155 |       }
 156 |       const remaining = Math.max(1, deadline - Date.now());
 157 |       const response = await Promise.race([connection.client.callTool({ name, arguments: args }, CallToolResultSchema, {
 158 |         timeout: remaining,
 159 |         maxTotalTimeout: remaining,
 160 |         resetTimeoutOnProgress: false,
 161 |       }), expired]);
 162 |       const result = CallToolResultSchema.parse(response);
 163 |       if (result.isError) {
 164 |         throw new LawMcpError(502, "MCP_TOOL_ERROR", "korean-law-mcp reported a tool failure.", result);
 165 |       }
 166 |       return {
 167 |         kind: "retrieval" as const,
 168 |         tool: name,
 169 |         server: connection.client.getServerVersion(),
 170 |         retrieved_at: new Date().toISOString(),
 171 |         // Retain text, resource links, structured content and upstream metadata.
 172 |         result,
 173 |       };
 174 |     } catch (error) {
 175 |       if (error instanceof LawMcpError) throw error;
 176 |       if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
 177 |         throw new LawMcpError(400, "MCP_INVALID_ARGUMENTS", "Arguments do not match the upstream tool. See /api/tools.");
 178 |       }
 179 |       // A timed-out child may still be doing network work. Retire the process
 180 |       // before permitting a fresh connection; never automatically replay calls.
 181 |       const retiring = connection ?? this.connection;
 182 |       if (retiring) await this.retire(retiring);
 183 |       // Retirement clears this.connection before it finishes. A timed-out
 184 |       // waiter must still await that cleanup and its own acquisition promise
 185 |       // before releasing capacity; Promise.race alone does not cancel it.
 186 |       await this.retiring;
 187 |       await acquiring?.catch(() => undefined);
 188 |       if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
 189 |         throw new LawMcpError(504, "MCP_TIMEOUT", "Legal retrieval timed out; the MCP process was reset.");
 190 |       }
 191 |       throw new LawMcpError(502, "MCP_CONNECTION_ERROR", "The legal MCP connection failed. A new request can reconnect.");
 192 |     } finally {
 193 |       clearTimeout(deadlineTimer);
 194 |       this.activeCalls--;
 195 |     }
 196 |   }
 197 |
 198 |   async close(): Promise<void> {
 199 |     this.stopped = true;
 200 |     if (this.connection) await this.retire(this.connection);
 201 |     await this.connecting?.catch(() => undefined);
 202 |     await this.retiring;
 203 |   }
 204 | }
 205 |
 206 | const ConnectTimeoutSchema = z.coerce.number().int().min(100).max(10_000);
 207 | const RequestTimeoutSchema = z.coerce.number().int().min(100).max(45_000);
 208 |
 209 | export const McpReleaseSchema = z.object({
 210 |   version: z.string().regex(/^\d+\.\d+\.\d+$/),
 211 |   entrypoint: z.string().refine(isAbsolute, "MCP entrypoint must be an absolute path"),
 212 | }).strict();
 213 |
 214 | export function koreanLawOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LawMcpOptions {
 215 |   // Resolve the executable path without importing/evaluating upstream source.
 216 |   const release = env.KOREAN_LAW_MCP_RELEASE_FILE
 217 |     ? McpReleaseSchema.parse(JSON.parse(readFileSync(env.KOREAN_LAW_MCP_RELEASE_FILE, "utf8")))
 218 |     : undefined;
 219 |   if (release && (env.KOREAN_LAW_MCP_COMMAND || env.KOREAN_LAW_MCP_ARGS || env.KOREAN_LAW_MCP_CWD)) {
 220 |     throw new Error("Use KOREAN_LAW_MCP_RELEASE_FILE or manual MCP command settings, not both.");
 221 |   }
 222 |   const entrypoint = release?.entrypoint ?? fileURLToPath(import.meta.resolve("korean-law-mcp"));
 223 |   const command = env.KOREAN_LAW_MCP_COMMAND || process.execPath;
 224 |   let args = [entrypoint, "--mode", "stdio"];
 225 |   if (env.KOREAN_LAW_MCP_COMMAND && !env.KOREAN_LAW_MCP_ARGS) {
 226 |     throw new Error("KOREAN_LAW_MCP_COMMAND requires KOREAN_LAW_MCP_ARGS (a JSON string array).");
 227 |   }
 228 |   if (env.KOREAN_LAW_MCP_ARGS) {
 229 |     args = z.array(z.string()).max(32).parse(JSON.parse(env.KOREAN_LAW_MCP_ARGS));
 230 |   }
 231 |   const childEnv: Record<string, string> = {};
 232 |   // Do not inherit Express's Supabase/GitHub credentials or NODE_OPTIONS.
 233 |   for (const key of ["LAW_API_PROTOCOL", "MCP_MAX_UPSTREAM_REQUESTS", "MCP_MAX_UPSTREAM_BODY_BYTES",
 234 |     "MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES", "MCP_MAX_TOOL_RESPONSE_CHARS"]) {
 235 |     if (env[key]) childEnv[key] = env[key];
 236 |   }
 237 |   childEnv.LAW_OC = env.LAW_OC || env.KOREAN_LAW_API_KEY || "";
 238 |   return {
 239 |     server: {
 240 |       command,
 241 |       args,
 242 |       env: childEnv,
 243 |       // Avoid loading the application's .env in the child process.
 244 |       cwd: env.KOREAN_LAW_MCP_CWD || dirname(entrypoint),
 245 |     },
 246 |     connectTimeoutMs: ConnectTimeoutSchema.parse(env.KOREAN_LAW_MCP_CONNECT_TIMEOUT_MS || 10_000),
 247 |     requestTimeoutMs: RequestTimeoutSchema.parse(env.KOREAN_LAW_MCP_TIMEOUT_MS || 45_000),
 248 |     maxConcurrentCalls: 3,
 249 |     releaseVersion: release?.version,
 250 |   };
 251 | }
 252 |
 253 | export function createKoreanLawClient(): KoreanLawClient {
 254 |   return new KoreanLawClient(koreanLawOptionsFromEnv());
 255 | }
 256 |
```

## tests/mcp-client.test.mjs
SHA256: d1e9854b7f013e64397b6957370162271e7e66add292e0a85db885894c33a470
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
  89 | test('an expired acquisition cannot retire another request that is still starting within its deadline',async t=>{
  90 |   const client=fixture(t,{requestTimeoutMs:3000});
  91 |   let finishRetirement;
  92 |   // Control only the prior retirement boundary. The new child still uses the
  93 |   // real SDK/stdio fixture, and both calls execute the production client code.
  94 |   client.retiring=new Promise(resolve=>{finishRetirement=resolve;});
  95 |   const expired=assert.rejects(client.callTool('search_law',{query:'expired'}),error=>error.code==='MCP_TIMEOUT');
  96 |   await new Promise(resolve=>setTimeout(resolve,2100));
  97 |   const live=client.callTool('search_law',{query:'live'});
  98 |   // Delay timer callbacks so retirement microtasks run with E expired and N
  99 |   // still valid. This reproduces the reported event-loop ordering explicitly.
 100 |   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);
 101 |   finishRetirement();
 102 |   const [,result]=await Promise.all([expired,live]);
 103 |   assert.equal(result.kind,'retrieval');assert.equal(result.result.structuredContent.args.query,'live');
 104 | });
 105 |
 106 | test('a crashed child is reported as failure and does not poison later requests', async t => {
 107 |   const client = fixture(t);
 108 |   await assert.rejects(client.callTool('search_law', { query: '__crash__' }), error => error.status === 502);
 109 |   const next = await client.callTool('search_law', { query: 'ok' });
 110 |   assert.equal(next.result.structuredContent.callNumber, 1);
 111 | });
 112 |
 113 | test('MCP capacity remains bounded independently of HTTP connection lifetime', async t => {
 114 |   const client = fixture(t);
 115 |   const requests = Array.from({ length: 3 }, () => client.callTool('search_law', { query: '__slow__' }));
 116 |   try {
 117 |     await assert.rejects(client.callTool('search_law', { query: 'excess' }), error => error.status === 429);
 118 |   } finally {
 119 |     await Promise.all(requests);
 120 |   }
 121 |   assert.equal((await client.callTool('search_law', { query: 'ok' })).result.structuredContent.callNumber, 4);
 122 | });
 123 |
 124 | test('missing executable and stalled initialization fail within the startup deadline', async t => {
 125 |   const options = koreanLawOptionsFromEnv({ LAW_OC: 'fixture' });
 126 |   const missing = fixture(t, { server: { ...options.server, command: 'missing-legal-harness-test-executable' } });
 127 |   await assert.rejects(missing.listTools(), error => error.status === 503);
 128 |   const stalled = fixture(t, {
 129 |     server: { ...options.server, command: process.execPath, args: [fixturePath, '--hang-start'] },
 130 |     connectTimeoutMs: 100,
 131 |   });
 132 |   const started = Date.now();
 133 |   await assert.rejects(stalled.listTools(), error => error.status === 503);
 134 |   assert.ok(Date.now() - started < 6000);
 135 | });
 136 |
 137 | test('closing the client reaps its child and prevents accidental respawn', async t => {
 138 |   const client = fixture(t);
 139 |   const result = await client.callTool('search_law', { query: 'ok' });
 140 |   await client.close();
 141 |   assert.throws(() => process.kill(result.result.structuredContent.pid, 0), { code: 'ESRCH' });
 142 |   await assert.rejects(client.listTools(), error => error.code === 'MCP_CLOSED');
 143 | });
 144 |
 145 | test('only explicit law settings reach the child, and absent LAW_OC cannot produce legal data', async t => {
 146 |   const keys = ['SUPABASE_ANON_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS'];
 147 |   const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
 148 |   t.after(() => {
 149 |     for (const key of keys) {
 150 |       if (before[key] === undefined) delete process.env[key];
 151 |       else process.env[key] = before[key];
 152 |     }
 153 |   });
 154 |   process.env.SUPABASE_ANON_KEY = 'must-not-inherit';
 155 |   process.env.GITHUB_TOKEN = 'must-not-inherit';
 156 |   process.env.NODE_OPTIONS = '--stack-trace-limit=2';
 157 |   const client = fixture(t);
 158 |   const result = await client.callTool('search_law', { query: 'ok' });
 159 |   assert.equal(result.result.structuredContent.inheritedSecrets, false);
 160 |   assert.equal(result.result.structuredContent.hasLawKey, true);
 161 |   const noKey = new KoreanLawClient(koreanLawOptionsFromEnv({}));
 162 |   t.after(() => noKey.close());
 163 |   await assert.rejects(noKey.callTool('search_law', { query: 'ok' }), error => error.code === 'MCP_NOT_CONFIGURED');
 164 | });
 165 |
 166 | test('installed korean-law-mcp release starts over stdio and advertises real tool schemas without API calls', async t => {
 167 |   const client = new KoreanLawClient(koreanLawOptionsFromEnv({}));
 168 |   t.after(() => client.close());
 169 |   const catalog = await client.listTools();
 170 |   assert.equal(catalog.server.name, 'korean-law');
 171 |   for (const name of ['legal_research', 'search_law', 'get_law_text', 'search_decisions', 'get_decision_text']) {
 172 |     assert.ok(catalog.tools.some(tool => tool.name === name && tool.inputSchema.type === 'object'), name);
 173 |   }
 174 | });
 175 |
 176 | test('deployment release file selects the verified upstream executable and rejects conflicting manual settings', async t => {
 177 |   const directory = await mkdtemp(join(tmpdir(), 'legal-harness-release-'));
 178 |   t.after(async () => {
 179 |     const target = await realpath(directory);
 180 |     assert.equal(dirname(target), await realpath(tmpdir()));
 181 |     assert.ok(basename(target).startsWith('legal-harness-release-'));
 182 |     await rm(target, { recursive: true, force: true });
 183 |   });
 184 |   const entrypoint = fileURLToPath(import.meta.resolve('korean-law-mcp'));
 185 |   const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('korean-law-mcp')), 'utf8'));
 186 |   const releaseFile = join(directory, 'active.json');
 187 |   await writeFile(releaseFile, JSON.stringify({ version: metadata.version, entrypoint }));
 188 |   const env = { KOREAN_LAW_MCP_RELEASE_FILE: releaseFile };
 189 |   const options = koreanLawOptionsFromEnv(env);
 190 |   assert.equal(options.server.args[0], entrypoint);
 191 |   assert.equal(options.releaseVersion, metadata.version);
 192 |   assert.throws(() => koreanLawOptionsFromEnv({ ...env, KOREAN_LAW_MCP_ARGS: '[]' }), /not both/);
 193 |   const client = new KoreanLawClient(options);
 194 |   t.after(() => client.close());
 195 |   assert.equal((await client.listTools()).server.version, metadata.version);
 196 | });
 197 |
 198 | test('a process whose version differs from its release manifest cannot initialize successfully', async t => {
 199 |   const client = fixture(t, { releaseVersion: '9.9.9' });
 200 |   await assert.rejects(client.listTools(), error => error.code === 'MCP_UNAVAILABLE');
 201 | });
 202 |
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
