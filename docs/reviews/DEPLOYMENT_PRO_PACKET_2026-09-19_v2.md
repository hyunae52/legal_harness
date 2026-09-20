# R1-R5 follow-up: immutable code snapshot

Commit: 4538471b7a7075aed23e97465c2054ef1202cac3

The original full snapshot is preserved by tag review/pro-input-20260919. Current Draft PR is https://github.com/hyunae52/legal_harness/pull/3. No merge/deployment has occurred. GitHub PAT lacked workflow scope, so review.yml was moved to deploy/review.workflow.yml.example; Linux CI is NOT run. Operational HTTPS/DB/worker/activation remain unverified and automatic maintenance remains disconnected.

Observed npm run review: 64 pass, 0 fail, 0 skipped/cancelled/todo. New tests include unrelated-skip arithmetic failure, partial history + timeout preservation, four KST midnight boundaries, total cold-child budget/warm success, expected diagnostic preservation in both REST and real MCP, secret/stack removal and size cap, real SSE stalls with/without headers, exact draft bytes. These were run by the implementing agent, not by the Pro reviewer.

Package pinning: the artifact now includes npm-shrinkwrap.json equal to package-lock.json. Plain local-tarball npm install on observed npm 11.8 ignored dependency shrinkwrap metadata and a new verification correctly failed on express 4.22.3 versus 4.22.2. Supported installers therefore run npm ci at the installed application root, with scripts/dev/optional omitted, before presenting/running the bridge. The clean-prefix test performs exactly those two install steps, then verifies installed direct versions plus real MCP/doctor/rules. Its final artifact result will be supplied separately; do not infer it passed before that result is supplied.


## src/contracts.ts
SHA256: 3065cdba66d5925848a72e1f7934a58e776c8c0888fc37ef7f4fe5691c30c6d6
```text
   1 | import { createHash } from 'node:crypto';
   2 | import { z } from 'zod';
   3 |
   4 | export const digest = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex');
   5 | export function stableJson(value: unknown): string {
   6 |   if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
   7 |   if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson((value as Record<string, unknown>)[k])).join(',') + '}';
   8 |   return JSON.stringify(value) ?? 'null';
   9 | }
  10 | export class ServiceError extends Error {
  11 |   constructor(public readonly status: number, public readonly code: string) { super(code); }
  12 | }
  13 | // Validate nonblank content without normalizing it: receipts bind the exact
  14 | // submitted draft, including Markdown whitespace and line breaks.
  15 | const DraftText=z.string().min(1).max(50_000).refine(s=>s.trim().length>0,'Draft must not be blank');
  16 | export const DraftSchema = z.object({
  17 |   draft_answer: DraftText,
  18 |   query: z.string().max(20_000).optional(),
  19 |   facts: z.record(z.unknown()).default({}),
  20 |   skip_gates: z.array(z.string().max(80)).max(10).default([]),
  21 |   bypass_reason: z.string().trim().min(1).max(500).optional(),
  22 |   mode: z.enum(['strict', 'warn']).default('strict'),
  23 |   force: z.boolean().default(false),
  24 | }).strict().superRefine((v, ctx) => {
  25 |   if ((v.force || v.mode === 'warn' || v.skip_gates.length) && !v.bypass_reason) ctx.addIssue({ code: 'custom', path: ['bypass_reason'], message: 'An explicit bypass reason is required.' });
  26 | });
  27 | export type DraftInput = z.input<typeof DraftSchema>;
  28 | export const AnalyzeSchema = z.object({
  29 |   query: z.string().trim().min(1).max(20_000),
  30 |   tool: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(128).default('legal_research'),
  31 |   arguments: z.record(z.unknown()).default({}),
  32 |   draft_answer: DraftText.optional(),
  33 |   facts: z.record(z.unknown()).default({}),
  34 |   skip_gates: z.array(z.string().max(80)).max(10).default([]),
  35 |   bypass_reason: z.string().trim().min(1).max(500).optional(),
  36 |   mode: z.enum(['strict', 'warn']).default('strict'),
  37 |   force: z.boolean().default(false),
  38 |   event_dates: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default({}),
  39 | }).strict();
  40 |
  41 | export interface Actor { id: string; kind: 'auth_user' | 'api_client'; userId?: string }
  42 | export interface FailureService {
  43 |   submit(actor: Actor, input: unknown): Promise<Record<string, unknown>>;
  44 |   status(actor: Actor, id: string): Promise<Record<string, unknown>>;
  45 | }
  46 |
```

## src/gates.ts
SHA256: 69cd646422e6087096a7709e3a0a883b94cf122418435c0e14b54f1bf9bc3841
```text
   1 | import { readFileSync } from 'node:fs';
   2 | import { resolve } from 'node:path';
   3 | import { fileURLToPath } from 'node:url';
   4 | import { randomUUID } from 'node:crypto';
   5 | import { z } from 'zod';
   6 | import { digest, DraftSchema, ServiceError } from './contracts.js';
   7 |
   8 | const RuleSchema = z.object({
   9 |   id: z.string().regex(/^QG-[A-Z]+-\d+$/), case_id: z.string().regex(/^FC-\d+$/),
  10 |   name: z.string().min(1), cues: z.array(z.string().min(1)).min(1),
  11 |   required_facts: z.array(z.string().min(1)).min(1), guidance: z.string().min(1),
  12 |   legal_status: z.literal('research_required'), version: z.literal(1),
  13 | }).strict();
  14 | type Rule = z.infer<typeof RuleSchema>;
  15 | export type CheckStatus = 'pass' | 'fail' | 'needs_info' | 'unverified' | 'not_applicable' | 'skipped';
  16 |
  17 | /** Cues select questions to ask; they are never evidence of a legal violation. */
  18 | export class GateEngine {
  19 |   readonly version: string;
  20 |   readonly rules: Rule[];
  21 |   constructor(directory = fileURLToPath(new URL('../rules/', import.meta.url))) {
  22 |     try {
  23 |       const names = z.array(z.string().regex(/^QG-[A-Z]+-\d+\.json$/)).min(10).max(100).parse(JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')));
  24 |       this.rules = names.map(name => RuleSchema.parse(JSON.parse(readFileSync(resolve(directory, name), 'utf8'))));
  25 |       if (new Set(this.rules.map(r => r.id)).size !== this.rules.length || this.rules.some((r, i) => names[i] !== `${r.id}.json`)) throw new Error('Duplicate rule');
  26 |       this.version = digest(this.rules);
  27 |     } catch { throw new ServiceError(503, 'RULESET_UNAVAILABLE'); }
  28 |   }
  29 |   validate(input: unknown, upstreamVersion: string) {
  30 |     const draft = DraftSchema.parse(input);
  31 |     if (draft.skip_gates.some(id => !this.rules.some(r => r.id === id))) throw new ServiceError(400, 'UNKNOWN_GATE');
  32 |     const text = `${draft.query ?? ''}\n${draft.draft_answer}`;
  33 |     const candidates = this.rules.filter(r => r.cues.some(c => text.includes(c)));
  34 |     const checks = candidates.map(rule => {
  35 |       const missing = rule.required_facts.filter(f => draft.facts[f] === undefined || draft.facts[f] === null);
  36 |       const status: CheckStatus = draft.skip_gates.includes(rule.id) ? 'skipped' : missing.length ? 'needs_info' : 'unverified';
  37 |       return { id: rule.id, case_id: rule.case_id, status, required_facts: missing, guidance: rule.guidance,
  38 |         scope: 'legal_applicability', reason: status === 'unverified' ? 'Official legal basis and draft/facts agreement have not been verified.' : status };
  39 |     });
  40 |     // A separate, useful arithmetic check. It makes no claim about the legally
  41 |     // correct allocation basis or the factual truth of caller-supplied amounts.
  42 |     const arithmetic = draft.facts.allocation;
  43 |     const arithmeticChecks: Array<{id: string; status: CheckStatus; scope: string; reason: string}> = [];
  44 |     if (arithmetic !== undefined) {
  45 |       const parsed = z.object({ total: z.number().int().nonnegative().safe(), parts: z.array(z.number().int().nonnegative().safe()).min(1).max(100) }).strict().parse(arithmetic);
  46 |       const sum = parsed.parts.reduce((a, b) => a + BigInt(b), 0n);
  47 |       arithmeticChecks.push({ id: 'ARITH-SUM-01', status: sum === BigInt(parsed.total) ? 'pass' : 'fail', scope: 'caller_supplied_arithmetic', reason: 'Sum of submitted allocations compared with submitted total; not a legal allocation ruling.' });
  48 |     }
  49 |     const all = [...checks, ...arithmeticChecks];
  50 |     const blockingBypass = draft.force || draft.mode === 'warn';
  51 |     const bypassed = blockingBypass || draft.skip_gates.length > 0;
  52 |     const complete = all.length > 0 && all.every(c => ['pass', 'fail', 'not_applicable'].includes(c.status));
  53 |     const scopedPass = complete && !bypassed && all.every(c => c.status !== 'fail');
  54 |     return { receipt_id: randomUUID(), checked_at: new Date().toISOString(), draft_hash: digest(draft.draft_answer), facts_hash: digest(draft.facts),
  55 |       rules_version: this.version, upstream_version: upstreamVersion, policy_version: 'scope-v1',
  56 |       checks: all, coverage: all.length ? 'limited' : 'no_coverage', assessment_complete: complete,
  57 |       scoped_pass: scopedPass, passed: false, // Legacy field never certifies an unassessed legal answer.
  58 |       legal_verification: 'unverified', draft_facts_agreement: 'unverified',
  59 |       blocked: !blockingBypass && all.some(c => c.status === 'fail'),
  60 |       bypass: { requested: bypassed, skipped: draft.skip_gates, reason: draft.bypass_reason ?? null },
  61 |       message: '제출한 사실·산식과 확인 범위에 대한 결과입니다. 법률 결론과 초안 전체가 검증된 것은 아닙니다.' };
  62 |   }
  63 | }
  64 |
```

## src/sourceVerifier.ts
SHA256: 885746c4bc3b76363148e20c02174b97a7dc5d8a7dab9340e7f12021b88a0cff
```text
   1 | import {z} from 'zod';
   2 | import {digest,ServiceError} from './contracts.js';
   3 | import type {KoreanLawClient} from './koreanLawClient.js';
   4 |
   5 | const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{
   6 |   const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;
   7 | },'Invalid calendar date');
   8 | export const SourceRequest=z.object({law_name:z.string().trim().min(1).max(120),law_id:z.string().regex(/^\d{1,12}$/),
   9 |   article:z.string().trim().min(1).max(40).optional(),event_dates:z.record(z.enum(['contract','transfer','management_disposal','tax_period_start']),date).default({})}).strict();
  10 | type SourceClient=Pick<KoreanLawClient,'callTool'|'listTools'|'close'>;
  11 | const errorCode=(error:unknown)=>error instanceof ServiceError?error.code:'SOURCE_REFRESH_FAILED';
  12 | function koreanDate(at:number){
  13 |   const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
  14 |   return ['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('');
  15 | }
  16 | /** Fresh upstream children avoid silently reusing an in-process law cache. */
  17 | export class SourceVerifier {
  18 |   private active=false;
  19 |   private stopped=false;
  20 |   private client?:SourceClient;
  21 |   private controller?:AbortController;
  22 |   private previous=new Map<string,{at:number;result:Record<string,unknown>;hash:string}>();
  23 |   constructor(private factory:()=>SourceClient,private now=()=>Date.now(),private timeoutMs=32_000){}
  24 |   async close(){this.stopped=true;this.controller?.abort(new ServiceError(503,'SOURCE_REFRESH_STOPPED'));await this.client?.close();}
  25 |   async check(input:unknown){
  26 |     const request=SourceRequest.parse(input);
  27 |     if(this.stopped)throw new ServiceError(503,'SOURCE_REFRESH_STOPPED');
  28 |     if(this.active)throw new ServiceError(429,'SOURCE_REFRESH_CAPACITY');
  29 |     this.active=true;
  30 |     const key=digest(request),old=this.previous.get(key),controller=new AbortController();this.controller=controller;
  31 |     const timer=setTimeout(()=>controller.abort(new ServiceError(504,'SOURCE_REFRESH_TIMEOUT')),this.timeoutMs);
  32 |     const aborted=new Promise<never>((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
  33 |     const bounded=<T>(operation:()=>Promise<T>)=>{controller.signal.throwIfAborted();return Promise.race([operation(),aborted]);};
  34 |     let client:SourceClient|undefined;
  35 |     try {
  36 |       const source=this.factory();client=source;this.client=source;
  37 |       const catalog=await bounded(()=>source.listTools());
  38 |       const current=await bounded(()=>source.callTool('get_law_text',{lawId:request.law_id,...(request.article?{jo:request.article}:{})}));
  39 |       const text=current.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  40 |       const name=/^법령명:\s*([^\n]+)$/m.exec(text)?.[1]?.trim();
  41 |       const normalize=(s:string)=>s.replace(/[\s·ㆍ]/g,'');
  42 |       if(!name||normalize(name)!==normalize(request.law_name))throw new ServiceError(422,'SOURCE_IDENTITY_UNRESOLVED');
  43 |       const effective=/^시행일:\s*(\d{8})$/m.exec(text)?.[1];
  44 |       const promulgation=/^공포일:\s*(\d{8})$/m.exec(text)?.[1];
  45 |       const observations=[];
  46 |       // Each historical role has its own access status. Failure must not erase
  47 |       // a successfully fetched current source or other successful role results.
  48 |       for(const [role,at] of Object.entries(request.event_dates)){
  49 |         try {
  50 |           const response=await bounded(()=>source.callTool('execute_tool',{tool_name:'applicable_law',params:{lawName:request.law_name,date:at,...(request.article?{jo:request.article}:{})}}));
  51 |           observations.push({role,date:at,source_access:'available',result:response.result,applicability:'unverified',transitional_provisions:'requires_interpretation'});
  52 |         }catch(error){observations.push({role,date:at,source_access:'unavailable',error_code:errorCode(error),result:null,applicability:'unverified',transitional_provisions:'unverified'});}
  53 |       }
  54 |       const hash=digest(current.result),now=this.now();
  55 |       const result={schema_version:1,source_access:'available',refresh_method:'fresh_upstream_process',checked_at:new Date(now).toISOString(),evaluation_timezone:'Asia/Seoul',
  56 |         source:{agency:'Ministry of Government Legislation',url:`https://www.law.go.kr/법령/${encodeURIComponent(name)}`,law_id:request.law_id,name,promulgation_date:promulgation??null,effective_date:effective??null},
  57 |         upstream_version:catalog.server?.version??'unidentified',content_hash:hash,previous_content_changed:old?old.hash!==hash:null,
  58 |         version_selection:!effective?'unresolved':effective>koreanDate(now)?'future':'current_candidate',
  59 |         current_result:current.result,historical_observations:observations,
  60 |         historical_access:observations.length===0?'not_requested':observations.every(o=>o.source_access==='available')?'available':observations.some(o=>o.source_access==='available')?'partial':'unavailable',
  61 |         applicability:'unverified',subsequent_interpretations:'unverified',
  62 |         note:'Fresh source retrieval does not determine transitional provisions or continuing validity of interpretations.'};
  63 |       // Bound fallback to 20 * 200KB; oversized results are never cached.
  64 |       if(Buffer.byteLength(JSON.stringify(result),'utf8')<=200_000){
  65 |         this.previous.delete(key);this.previous.set(key,{at:now,result,hash});
  66 |         if(this.previous.size>20)this.previous.delete(this.previous.keys().next().value!);
  67 |       }
  68 |       return result;
  69 |     }catch(error){
  70 |       const usable=old&&this.now()-old.at<86_400_000?old:undefined;
  71 |       return {schema_version:1,source_access:'unavailable',version_selection:'unresolved',applicability:'unverified',
  72 |         checked_at:new Date(this.now()).toISOString(),error_code:errorCode(error),previous:usable?{age_seconds:Math.floor((this.now()-usable.at)/1000),result:usable.result}:null};
  73 |     }finally{
  74 |       clearTimeout(timer);
  75 |       try{await client?.close();}finally{this.client=undefined;this.controller=undefined;this.active=false;}
  76 |     }
  77 |   }
  78 | }
  79 |
```

## src/koreanLawClient.ts
SHA256: f28cfe638b847c39218b57a6f7106a76d699e9f30d7e4d7644171fa46ea41778
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
 110 |   private async getConnection(): Promise<Connection> {
 111 |     await this.retiring;
 112 |     if (this.stopped) throw new LawMcpError(503, "MCP_CLOSED", "The legal MCP client is shutting down.");
 113 |     if (this.connecting) return this.connecting;
 114 |     if (this.connection?.ready) return this.connection;
 115 |     const connecting = this.openConnection();
 116 |     this.connecting = connecting;
 117 |     try {
 118 |       return await connecting;
 119 |     } finally {
 120 |       if (this.connecting === connecting) this.connecting = undefined;
 121 |     }
 122 |   }
 123 |
 124 |   async listTools() {
 125 |     const connection = await this.getConnection();
 126 |     return { server: connection.client.getServerVersion(), tools: connection.tools };
 127 |   }
 128 |
 129 |   async callTool(name: string, args: Record<string, unknown>) {
 130 |     if (!this.options.server.env?.LAW_OC) {
 131 |       throw new LawMcpError(503, "MCP_NOT_CONFIGURED", "Set LAW_OC on the Express server before requesting legal data.");
 132 |     }
 133 |     // Keep this slot until work ends, even if the HTTP caller disconnects.
 134 |     if (this.activeCalls >= this.options.maxConcurrentCalls) {
 135 |       throw new LawMcpError(429, "MCP_AT_CAPACITY", "Legal retrieval is at capacity. Please retry later.");
 136 |     }
 137 |     this.activeCalls++;
 138 |     const deadline = Date.now() + this.options.requestTimeoutMs;
 139 |     let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
 140 |     const expired = new Promise<never>((_resolve, reject) => {
 141 |       deadlineTimer = setTimeout(() => reject(new McpError(ErrorCode.RequestTimeout, 'Legal retrieval deadline exceeded')), this.options.requestTimeoutMs);
 142 |     });
 143 |     let connection: Connection | undefined;
 144 |     try {
 145 |       connection = await Promise.race([this.getConnection(), expired]);
 146 |       if (!connection.tools.some(tool => tool.name === name)) {
 147 |         throw new LawMcpError(400, "MCP_UNKNOWN_TOOL", "Tool is not advertised by korean-law-mcp. See /api/tools.");
 148 |       }
 149 |       const remaining = Math.max(1, deadline - Date.now());
 150 |       const response = await Promise.race([connection.client.callTool({ name, arguments: args }, CallToolResultSchema, {
 151 |         timeout: remaining,
 152 |         maxTotalTimeout: remaining,
 153 |         resetTimeoutOnProgress: false,
 154 |       }), expired]);
 155 |       const result = CallToolResultSchema.parse(response);
 156 |       if (result.isError) {
 157 |         throw new LawMcpError(502, "MCP_TOOL_ERROR", "korean-law-mcp reported a tool failure.", result);
 158 |       }
 159 |       return {
 160 |         kind: "retrieval" as const,
 161 |         tool: name,
 162 |         server: connection.client.getServerVersion(),
 163 |         retrieved_at: new Date().toISOString(),
 164 |         // Retain text, resource links, structured content and upstream metadata.
 165 |         result,
 166 |       };
 167 |     } catch (error) {
 168 |       if (error instanceof LawMcpError) throw error;
 169 |       if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
 170 |         throw new LawMcpError(400, "MCP_INVALID_ARGUMENTS", "Arguments do not match the upstream tool. See /api/tools.");
 171 |       }
 172 |       // A timed-out child may still be doing network work. Retire the process
 173 |       // before permitting a fresh connection; never automatically replay calls.
 174 |       const retiring = connection ?? this.connection;
 175 |       if (retiring) await this.retire(retiring);
 176 |       if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
 177 |         throw new LawMcpError(504, "MCP_TIMEOUT", "Legal retrieval timed out; the MCP process was reset.");
 178 |       }
 179 |       throw new LawMcpError(502, "MCP_CONNECTION_ERROR", "The legal MCP connection failed. A new request can reconnect.");
 180 |     } finally {
 181 |       clearTimeout(deadlineTimer);
 182 |       this.activeCalls--;
 183 |     }
 184 |   }
 185 |
 186 |   async close(): Promise<void> {
 187 |     this.stopped = true;
 188 |     if (this.connection) await this.retire(this.connection);
 189 |     await this.connecting?.catch(() => undefined);
 190 |     await this.retiring;
 191 |   }
 192 | }
 193 |
 194 | const ConnectTimeoutSchema = z.coerce.number().int().min(100).max(10_000);
 195 | const RequestTimeoutSchema = z.coerce.number().int().min(100).max(45_000);
 196 |
 197 | export const McpReleaseSchema = z.object({
 198 |   version: z.string().regex(/^\d+\.\d+\.\d+$/),
 199 |   entrypoint: z.string().refine(isAbsolute, "MCP entrypoint must be an absolute path"),
 200 | }).strict();
 201 |
 202 | export function koreanLawOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LawMcpOptions {
 203 |   // Resolve the executable path without importing/evaluating upstream source.
 204 |   const release = env.KOREAN_LAW_MCP_RELEASE_FILE
 205 |     ? McpReleaseSchema.parse(JSON.parse(readFileSync(env.KOREAN_LAW_MCP_RELEASE_FILE, "utf8")))
 206 |     : undefined;
 207 |   if (release && (env.KOREAN_LAW_MCP_COMMAND || env.KOREAN_LAW_MCP_ARGS || env.KOREAN_LAW_MCP_CWD)) {
 208 |     throw new Error("Use KOREAN_LAW_MCP_RELEASE_FILE or manual MCP command settings, not both.");
 209 |   }
 210 |   const entrypoint = release?.entrypoint ?? fileURLToPath(import.meta.resolve("korean-law-mcp"));
 211 |   const command = env.KOREAN_LAW_MCP_COMMAND || process.execPath;
 212 |   let args = [entrypoint, "--mode", "stdio"];
 213 |   if (env.KOREAN_LAW_MCP_COMMAND && !env.KOREAN_LAW_MCP_ARGS) {
 214 |     throw new Error("KOREAN_LAW_MCP_COMMAND requires KOREAN_LAW_MCP_ARGS (a JSON string array).");
 215 |   }
 216 |   if (env.KOREAN_LAW_MCP_ARGS) {
 217 |     args = z.array(z.string()).max(32).parse(JSON.parse(env.KOREAN_LAW_MCP_ARGS));
 218 |   }
 219 |   const childEnv: Record<string, string> = {};
 220 |   // Do not inherit Express's Supabase/GitHub credentials or NODE_OPTIONS.
 221 |   for (const key of ["LAW_API_PROTOCOL", "MCP_MAX_UPSTREAM_REQUESTS", "MCP_MAX_UPSTREAM_BODY_BYTES",
 222 |     "MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES", "MCP_MAX_TOOL_RESPONSE_CHARS"]) {
 223 |     if (env[key]) childEnv[key] = env[key];
 224 |   }
 225 |   childEnv.LAW_OC = env.LAW_OC || env.KOREAN_LAW_API_KEY || "";
 226 |   return {
 227 |     server: {
 228 |       command,
 229 |       args,
 230 |       env: childEnv,
 231 |       // Avoid loading the application's .env in the child process.
 232 |       cwd: env.KOREAN_LAW_MCP_CWD || dirname(entrypoint),
 233 |     },
 234 |     connectTimeoutMs: ConnectTimeoutSchema.parse(env.KOREAN_LAW_MCP_CONNECT_TIMEOUT_MS || 10_000),
 235 |     requestTimeoutMs: RequestTimeoutSchema.parse(env.KOREAN_LAW_MCP_TIMEOUT_MS || 45_000),
 236 |     maxConcurrentCalls: 3,
 237 |     releaseVersion: release?.version,
 238 |   };
 239 | }
 240 |
 241 | export function createKoreanLawClient(): KoreanLawClient {
 242 |   return new KoreanLawClient(koreanLawOptionsFromEnv());
 243 | }
 244 |
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

## src/errorDiagnostics.ts
SHA256: 5d3f1909e42ea8851e8809e08dd75f4c2fb13d69ad9ae186d77620d05e262288
```text
   1 | import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
   2 | /** Only expected upstream tool-result diagnostics enter this sanitizer. Never
   3 |  * pass an exception, stderr, stack or arbitrary server object to it. */
   4 | export function safeToolDiagnostic(result:CallToolResult,env:NodeJS.ProcessEnv):CallToolResult {
   5 |   const secrets=Object.entries(env).filter(([key,value])=>value&&value.length>=4&&/key|token|secret|password|^LAW_OC$/i.test(key)).flatMap(([,v])=>[v!,encodeURIComponent(v!)]);
   6 |   const scrub=(input:string,max=2000)=>{
   7 |     let text=input;
   8 |     for(const secret of secrets)text=text.split(secret).join('[REDACTED]');
   9 |     text=text.replace(/([?&](?:OC|apiKey|key|token|password)=)[^&#\s]+/gi,'$1[REDACTED]')
  10 |       .replace(/\bBearer\s+[^\s"']+/gi,'Bearer [REDACTED]')
  11 |       .replace(/\b((?:[A-Z_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)|Authorization|OC))\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1=[REDACTED]')
  12 |       .replace(/^\s*(?:at\s+.+|Traceback.*|File ".+", line .*)$/gm,'[INTERNAL TRACE OMITTED]')
  13 |       .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}/g,'[REDACTED]')
  14 |       .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]');
  15 |     return text.slice(0,max);
  16 |   };
  17 |   let budget=120;
  18 |   const clean=(value:unknown,depth=0):unknown=>{
  19 |     if(--budget<0||depth>4)return '[OMITTED]';
  20 |     if(typeof value==='string')return scrub(value);
  21 |     if(value===null||typeof value==='boolean'||typeof value==='number')return value;
  22 |     if(Array.isArray(value))return value.slice(0,20).map(v=>clean(v,depth+1));
  23 |     if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:token|password|secret|headers?|authorization|cookie|stack|stderr|environment|^env$|api.?key|^oc$|__proto__|constructor)/i.test(key)).slice(0,20).map(([k,v])=>[scrub(k,100),clean(v,depth+1)]));
  24 |     return null;
  25 |   };
  26 |   const content=result.content.filter(c=>c.type==='text').slice(0,3).map(c=>({type:'text' as const,text:scrub(c.text,3000)}));
  27 |   if(!content.length)content.push({type:'text',text:'Upstream tool reported an error. Check the tool arguments or source availability.'});
  28 |   const structured=clean(result.structuredContent);
  29 |   const output:CallToolResult={isError:true,content,...(structured&&typeof structured==='object'&&!Array.isArray(structured)?{structuredContent:structured as Record<string,unknown>}:{})};
  30 |   if(Buffer.byteLength(JSON.stringify(output),'utf8')>16000)return {isError:true,content:[{type:'text',text:scrub(content[0].text,2000)}],structuredContent:{diagnostics_truncated:true}};
  31 |   return output;
  32 | }
  33 |
```

## scripts/hermes-mcp-bridge.mjs
SHA256: 75ce4e51f7465006946ed51617389051cfab45159f212f8aea47acea40581d20
```text
   1 | #!/usr/bin/env node
   2 | import { Client } from '@modelcontextprotocol/sdk/client/index.js';
   3 | import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
   4 | import { Server } from '@modelcontextprotocol/sdk/server/index.js';
   5 | import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
   6 | import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
   7 |
   8 | const origin = new URL(process.env.TAXLAB_SERVER_URL || 'https://law.taxlab.kr');
   9 | const loopback = ['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
  10 | if ((origin.protocol !== 'https:' && !(loopback && process.env.TAXLAB_ALLOW_LOOPBACK_HTTP === '1')) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  11 |   throw new Error('TAXLAB_SERVER_URL must be an HTTPS origin without credentials or query parameters.');
  12 | }
  13 | const token = process.env.TAXLAB_API_KEY || process.env.TAXLAB_AUTH_TOKEN;
  14 | if (!token) throw new Error('Set TAXLAB_API_KEY or TAXLAB_AUTH_TOKEN in the MCP client environment.');
  15 | const headers = process.env.TAXLAB_AUTH_TOKEN ? {authorization:'Bearer '+process.env.TAXLAB_AUTH_TOKEN} : {'x-api-key':token};
  16 | const connectTimeout=Number(process.env.TAXLAB_CONNECT_TIMEOUT_MS||15000);
  17 | if(!Number.isInteger(connectTimeout)||connectTimeout<250||connectTimeout>30000)throw new Error('Invalid bridge connection timeout.');
  18 | const safeFetch = (url, init) => {
  19 |   if (new URL(url).origin !== origin.origin) throw new Error('Cross-origin MCP request blocked.');
  20 |   return fetch(url,{...init,redirect:'error'});
  21 | };
  22 | let remote, connecting, stopped=false;
  23 | async function getRemote() {
  24 |   if (stopped) throw new Error('Bridge closed.');
  25 |   if (remote) return remote;
  26 |   if (connecting) return connecting;
  27 |   connecting=(async()=>{
  28 |     const client=new Client({name:'taxlab-stdio-bridge',version:'2.2.0'});
  29 |     client.onclose=()=>{if(remote===client) remote=undefined;};
  30 |     const transport=new SSEClientTransport(new URL('/sse',origin),{requestInit:{headers},fetch:safeFetch});
  31 |     // SDK request timeout starts after transport.start(). Bound the full SSE
  32 |     // startup too: an open stream without an endpoint must not hang forever.
  33 |     let timer,expired=false;
  34 |     try {
  35 |       const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('Bridge connection deadline'));},connectTimeout);});
  36 |       await Promise.race([client.connect(transport,{timeout:connectTimeout}),timeout]);
  37 |       if(stopped||expired)throw new Error('Bridge closed.');
  38 |       remote=client;return client;
  39 |     }catch(error){await client.close();await transport.close();throw error;}
  40 |     finally{clearTimeout(timer);}
  41 |   })();
  42 |   try{return await connecting;}finally{connecting=undefined;}
  43 | }
  44 | const local=new Server({name:'taxlab-legal-bridge',version:'2.2.0'},{capabilities:{tools:{}}});
  45 | local.setRequestHandler(ListToolsRequestSchema,async()=>await(await getRemote()).listTools(undefined,{timeout:20000}));
  46 | // A lost response may already have committed a failure receipt. Do not replay.
  47 | local.setRequestHandler(CallToolRequestSchema,async request=>{
  48 |   // Server retrieval: <=45s including child connection, then <=4s SDK cleanup;
  49 |   // allow authentication/network margin without automatically replaying writes.
  50 |   try{return await(await getRemote()).callTool(request.params,undefined,{timeout:60000,maxTotalTimeout:60000,resetTimeoutOnProgress:false});}
  51 |   catch{await remote?.close();remote=undefined;return {isError:true,content:[{type:'text',text:'Remote request failed. Check connection; for writes, query the existing receipt before retrying.'}]};}
  52 | });
  53 | async function close(){if(stopped)return;stopped=true;await remote?.close();await local.close();}
  54 | local.onclose=()=>void close();
  55 | process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
  56 | try {
  57 |   if(process.argv.includes('--doctor')) {
  58 |     const health=await safeFetch(new URL('/health',origin),{headers,signal:AbortSignal.timeout(10000)});
  59 |     if(!health.ok) throw new Error('Health failed');
  60 |     const tools=await(await getRemote()).listTools(undefined,{timeout:15000});
  61 |     if(!tools.tools.some(t=>t.name==='search_law')) throw new Error('Catalog missing law tools');
  62 |     console.log(JSON.stringify({status:'ok',origin:origin.origin,tools:tools.tools.length}));await close();
  63 |   } else {await local.connect(new StdioServerTransport());}
  64 | } catch {console.error('Legal MCP connection failed. Verify HTTPS, authentication and installed package; no request was automatically replayed.');await close();process.exitCode=1;}
  65 |
```

## scripts/package-smoke.mjs
SHA256: a2c30713d6c0581b05c4fdb605f051e1a3e3395f9990878fe0ce93a5ffaafec6
```text
   1 | // Pack, install into an empty prefix, then exercise real stdio -> SSE -> app.
   2 | import assert from 'node:assert/strict';
   3 | import {execFile} from 'node:child_process';
   4 | import {promisify} from 'node:util';
   5 | import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
   6 | import {resolve,join,dirname} from 'node:path';
   7 | import {fileURLToPath} from 'node:url';
   8 | import {createHash} from 'node:crypto';
   9 | import {createServer} from 'node:http';
  10 | import {Client} from '@modelcontextprotocol/sdk/client/index.js';
  11 | import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
  12 | import {createApp} from '../dist/app.js';
  13 | const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  14 | const exec=promisify(execFile),npm=process.env.npm_execpath;
  15 | if(!npm) throw Error('Run npm run review:package');
  16 | const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME','USERPROFILE','COMSPEC','ComSpec','PATHEXT'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  17 | await mkdir(join(root,'.runtime'),{recursive:true});
  18 | const work=await mkdtemp(join(root,'.runtime','package-review-'));
  19 | const command=async args=>(await exec(process.execPath,[npm,...args],{cwd:root,env,windowsHide:true,timeout:180000,maxBuffer:4*1024*1024})).stdout;
  20 | const [packed]=JSON.parse(await command(['pack','--ignore-scripts','--json','--pack-destination',work]));
  21 | assert.ok(packed.files.every(f=>!/(^|\/)(?:\.env(?:\.|$)|docs|tests|\.git|\.runtime)/.test(f.path)),'Private files in package');
  22 | assert.ok(packed.files.some(f=>f.path==='rules/manifest.json'));
  23 | assert.ok(packed.files.some(f=>f.path==='npm-shrinkwrap.json'),'Published dependencies must be pinned');
  24 | assert.deepEqual(JSON.parse(await readFile(join(root,'npm-shrinkwrap.json'),'utf8')),JSON.parse(await readFile(join(root,'package-lock.json'),'utf8')),'Published and development locks must agree');
  25 | const artifact=join(work,packed.filename),prefix=join(work,'clean-prefix');
  26 | await mkdir(prefix);await writeFile(join(prefix,'package.json'),'{"private":true}');
  27 | await command(['install','--prefix',prefix,'--ignore-scripts','--omit=optional','--no-audit','--no-fund',artifact]);
  28 | const installed=join(prefix,'node_modules/k-tax-agent-backend');
  29 | // Local-tarball npm install may ignore a dependency's shrinkwrap metadata.
  30 | // Treat the installed CLI as a locked application root before ever running it.
  31 | await command(['ci','--prefix',installed,'--ignore-scripts','--omit=dev','--omit=optional','--no-audit','--no-fund']);
  32 | const shrinkwrap=JSON.parse(await readFile(join(installed,'npm-shrinkwrap.json'),'utf8'));
  33 | assert.deepEqual(shrinkwrap,JSON.parse(await readFile(join(root,'package-lock.json'),'utf8')));
  34 | const versions={};
  35 | for(const name of Object.keys(shrinkwrap.packages[''].dependencies)){
  36 |   let metadata;for(const location of [join(installed,'node_modules',name,'package.json'),join(prefix,'node_modules',name,'package.json')]){try{metadata=JSON.parse(await readFile(location,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}}
  37 |   assert.equal(metadata?.version,shrinkwrap.packages['node_modules/'+name].version,`Installed version drift: ${name}`);versions[name]=metadata.version;
  38 | }
  39 | const runtime=createApp({env:{TAXLAB_API_KEY:'package-fixture'},law:{releaseVersion:'fixture',listTools:async()=>({tools:[{name:'search_law',inputSchema:{type:'object'}}]}),callTool:async()=>({result:{content:[{type:'text',text:'package-fixture-result'}]}}),close:async()=>{}}});
  40 | const server=createServer(runtime.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  41 | const childEnv={...env,TAXLAB_API_KEY:'package-fixture',TAXLAB_SERVER_URL:`http://127.0.0.1:${server.address().port}`,TAXLAB_ALLOW_LOOPBACK_HTTP:'1'};
  42 | const client=new Client({name:'clean-package-check',version:'1'});
  43 | const transport=new StdioClientTransport({command:process.execPath,args:[join(installed,'scripts/hermes-mcp-bridge.mjs')],cwd:prefix,env:childEnv,stderr:'pipe'});
  44 | transport.stderr?.on('data',()=>{});
  45 | try {
  46 |   await client.connect(transport,{timeout:5000});
  47 |   const tools=await client.listTools(undefined,{timeout:5000});assert.ok(tools.tools.some(t=>t.name==='validate_legal_draft'));
  48 |   const result=await client.callTool({name:'search_law',arguments:{query:'synthetic'}},undefined,{timeout:5000});assert.equal(result.content[0].text,'package-fixture-result');
  49 |   const {stdout}=await exec(process.execPath,[join(installed,'scripts/hermes-mcp-bridge.mjs'),'--doctor'],{cwd:prefix,env:childEnv,windowsHide:true,timeout:10000});assert.equal(JSON.parse(stdout).status,'ok');
  50 |   const {stdout:imported}=await exec(process.execPath,['--input-type=module','-e',"const {GateEngine}=await import('k-tax-agent-backend/dist/gates.js');console.log(new GateEngine().rules.length)"],{cwd:prefix,env,windowsHide:true,timeout:10000});assert.equal(imported.trim(),'10');
  51 |   const digest=createHash('sha256').update(await readFile(artifact)).digest('hex');
  52 |   await writeFile(join(work,'evidence.json'),JSON.stringify({status:'pass',artifact,sha256:digest,files:packed.files.length,checks:['clean_install','stdio_sse_authenticated_call','doctor','packaged_rules','published_lock','installed_dependency_versions'],versions,fixture_only:true},null,2));
  53 |   console.log(JSON.stringify({status:'pass',artifact,sha256:digest,checks:6,versions}));
  54 | } finally {
  55 |   await client.close();await transport.close();await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  56 | }
  57 |
```

## scripts/install-mcp.ps1
SHA256: 1a37b13565029556a7d9b3e83974a834670da8c89ee80d4e0aad70e08d33d3d3
```text
   1 | # Install a reviewed, locally downloaded npm tarball, including dependencies.
   2 | # Example: .\scripts\install-mcp.ps1 -Package C:\Downloads\k-tax-agent-backend-2.2.0.tgz
   3 | param([Parameter(Mandatory=$true)][string]$Package,
   4 |       [string]$Destination = (Join-Path $env:USERPROFILE '.taxlab\legal-mcp'))
   5 | $ErrorActionPreference = 'Stop'
   6 | $artifact = (Resolve-Path -LiteralPath $Package).Path
   7 | if (-not $artifact.EndsWith('.tgz')) { throw 'Select the reviewed npm .tgz artifact.' }
   8 | node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
   9 | if ($LASTEXITCODE -ne 0) { throw 'Node.js 22 or later is required.' }
  10 | New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  11 | & npm install --prefix $Destination --ignore-scripts --omit=optional --no-audit --no-fund -- $artifact
  12 | if ($LASTEXITCODE -ne 0) { throw 'Package installation failed.' }
  13 | $application = Join-Path $Destination 'node_modules\k-tax-agent-backend'
  14 | & npm ci --prefix $application --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund
  15 | if ($LASTEXITCODE -ne 0) { throw 'Pinned application dependency installation failed.' }
  16 | $bridge = Join-Path $Destination 'node_modules\k-tax-agent-backend\scripts\hermes-mcp-bridge.mjs'
  17 | if (-not (Test-Path -LiteralPath $bridge)) { throw 'Installed bridge is missing.' }
  18 | @{mcpServers=@{'taxlab-legal'=@{command='node';args=@($bridge);env=@{
  19 |     TAXLAB_SERVER_URL='https://law.taxlab.kr';TAXLAB_API_KEY='<your existing server key>'
  20 | }}}} | ConvertTo-Json -Depth 8
  21 | Write-Host 'Add this entry to your MCP client. Existing configurations have not been overwritten.'
  22 | Write-Host 'Set the key in your client environment, then run the installed bridge with --doctor.'
  23 |
```

## scripts/install-mcp.sh
SHA256: efe6a282794d36235f82f17ab5b4b096f496ceacd67b585c88ba1a6d19b9f8f4
```text
   1 | #!/usr/bin/env bash
   2 | # Install a reviewed local tarball. No network script piping or agent config guessing.
   3 | set -euo pipefail
   4 | artifact="${1:?Usage: bash scripts/install-mcp.sh /absolute/path/reviewed-package.tgz [destination]}"
   5 | destination="${2:-$HOME/.taxlab/legal-mcp}"
   6 | case "$artifact" in /*.tgz) ;; *) echo 'Provide an absolute path to the reviewed npm tarball.' >&2; exit 1;; esac
   7 | test -f "$artifact"
   8 | node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
   9 | mkdir -p -- "$destination"
  10 | npm install --prefix "$destination" --ignore-scripts --omit=optional --no-audit --no-fund -- "$artifact"
  11 | npm ci --prefix "$destination/node_modules/k-tax-agent-backend" --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund
  12 | node --input-type=module - "$destination" <<'NODE'
  13 | import {resolve} from 'node:path';
  14 | import {access} from 'node:fs/promises';
  15 | const bridge=resolve(process.argv[2],'node_modules/k-tax-agent-backend/scripts/hermes-mcp-bridge.mjs');
  16 | await access(bridge);
  17 | console.log(JSON.stringify({mcpServers:{'taxlab-legal':{command:'node',args:[bridge],env:{TAXLAB_SERVER_URL:'https://law.taxlab.kr',TAXLAB_API_KEY:'<your existing server key>'}}}},null,2));
  18 | console.log('Add this entry to your MCP client. Existing configurations have not been overwritten.');
  19 | console.log('Set the key in your client environment, then run the installed bridge with --doctor.');
  20 | NODE
  21 |
```

## tests/bridge-startup.test.mjs
SHA256: 6c34be05386bbb28b69d9efc18277b386907a9663d2a153e008401482566560e
```text
   1 | import assert from 'node:assert/strict';
   2 | import test from 'node:test';
   3 | import {createServer} from 'node:http';
   4 | import {execFile} from 'node:child_process';
   5 | import {promisify} from 'node:util';
   6 | import {fileURLToPath} from 'node:url';
   7 | const run=promisify(execFile);
   8 | for(const headersOnly of [false,true])test(`bridge full startup deadline covers stalled SSE ${headersOnly?'without endpoint':'without headers'}`,async t=>{
   9 |   const server=createServer((req,res)=>{
  10 |     if(req.url==='/health'){res.setHeader('content-type','application/json');res.end('{"status":"ok"}');}
  11 |     else if(headersOnly){res.writeHead(200,{'content-type':'text/event-stream','connection':'keep-alive'});res.write(': heartbeat\n\n');}
  12 |   });
  13 |   await new Promise(r=>server.listen(0,'127.0.0.1',r));
  14 |   t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  15 |   const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME','USERPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  16 |   const started=Date.now();
  17 |   await assert.rejects(run(process.execPath,[fileURLToPath(new URL('../scripts/hermes-mcp-bridge.mjs',import.meta.url)),'--doctor'],{env:{...env,TAXLAB_SERVER_URL:`http://127.0.0.1:${server.address().port}`,TAXLAB_ALLOW_LOOPBACK_HTTP:'1',TAXLAB_API_KEY:'fixture',TAXLAB_CONNECT_TIMEOUT_MS:'250'},windowsHide:true,timeout:5000}),error=>{
  18 |     assert.equal(error.killed,false,'outer test deadline must not kill a hung bridge');assert.equal(error.code,1);assert.match(error.stderr,/Legal MCP connection failed/);return true;
  19 |   });
  20 |   assert.ok(Date.now()-started<5000);
  21 | });
  22 |
```

## tests/source-verifier.test.mjs
SHA256: 4bb437a3960f50561b96efe4e9130dc589bd3f78deb2f76030553506d2139f7b
```text
   1 | import assert from 'node:assert/strict';
   2 | import test from 'node:test';
   3 | import {SourceVerifier} from '../dist/sourceVerifier.js';
   4 | test('freshness check opens fresh upstream, preserves role dates, detects change and labels stale fallback',async()=>{
   5 |   let count=0,closed=0,fail=false,body='법령명: 근로기준법\n공포일: 20240101\n시행일: 20240101\nFixture',time=Date.parse('2026-09-19T00:00:00Z');
   6 |   const calls=[];
   7 |   const verifier=new SourceVerifier(()=>{count++;return {listTools:async()=>({server:{version:'4.13.0'}}),close:async()=>{closed++;},callTool:async(name,args)=>{
   8 |     calls.push({name,args});if(fail) throw Error('secret');return {result:{content:[{type:'text',text:name==='get_law_text'?body:'historical/addenda candidate'}]}};
   9 |   }};},()=>time);
  10 |   const input={law_name:'근로기준법',law_id:'001872',event_dates:{contract:'2024-02-01',transfer:'2025-03-01'}};
  11 |   const first=await verifier.check(input);assert.equal(first.source_access,'available');assert.equal(first.historical_observations.length,2);assert.equal(first.applicability,'unverified');
  12 |   assert.equal(calls[1].args.params.date,'2024-02-01');
  13 |   body+=' changed';const second=await verifier.check(input);assert.equal(second.previous_content_changed,true);assert.equal(count,2);assert.equal(closed,2);
  14 |   fail=true;time+=60000;const outage=await verifier.check(input);assert.equal(outage.source_access,'unavailable');assert.equal(outage.previous.age_seconds,60);assert.equal(outage.version_selection,'unresolved');
  15 |   time+=86_400_000;assert.equal((await verifier.check(input)).previous,null);
  16 |   await assert.rejects(verifier.check({...input,event_dates:{contract:'2024-02-30'}}));
  17 | });
  18 | test('wrong law identity and future effective dates do not become historical/current confirmation',async()=>{
  19 |   let law='Other',effective='20300101';
  20 |   const verifier=new SourceVerifier(()=>({listTools:async()=>({}),close:async()=>{},callTool:async()=>({result:{content:[{type:'text',text:`법령명: ${law}\n시행일: ${effective}`}]}})}));
  21 |   const input={law_name:'Expected',law_id:'1'};
  22 |   assert.equal((await verifier.check(input)).error_code,'SOURCE_IDENTITY_UNRESOLVED');
  23 |   law='Expected';assert.equal((await verifier.check(input)).version_selection,'future');
  24 | });
  25 | test('a hung source refresh has an overall deadline and shutdown prevents new children',async()=>{
  26 |   let closed=0,opened=0;
  27 |   const verifier=new SourceVerifier(()=>{opened++;return {listTools:()=>new Promise(()=>{}),callTool:async()=>{},close:async()=>{closed++;}};},()=>Date.now(),25);
  28 |   const input={law_name:'Fixture',law_id:'1'};
  29 |   const pending=verifier.check(input);
  30 |   await assert.rejects(verifier.check(input),e=>e.code==='SOURCE_REFRESH_CAPACITY');
  31 |   assert.equal((await pending).error_code,'SOURCE_REFRESH_TIMEOUT');assert.equal(closed,1);
  32 |   const next=verifier.check(input);await verifier.close();assert.equal((await next).error_code,'SOURCE_REFRESH_STOPPED');
  33 |   await assert.rejects(verifier.check(input),e=>e.code==='SOURCE_REFRESH_STOPPED');assert.equal(opened,2);
  34 | });
  35 | test('partial history failure retains current source and successful roles; dates use Korea midnight',async()=>{
  36 |   let hang=false;
  37 |   const verifier=new SourceVerifier(()=>({listTools:async()=>({}),close:async()=>{},callTool:async(name,args)=>{
  38 |     if(name==='get_law_text')return {result:{content:[{type:'text',text:'법령명: Fixture\n시행일: 20260920'}]}};
  39 |     if(args.params.date==='2024-01-01'){if(hang)return new Promise(()=>{});throw Error('history dependency failure');}
  40 |     return {result:{content:[{type:'text',text:'successful history'}]}};
  41 |   }}),()=>Date.parse('2026-09-19T15:00:00Z'),25);
  42 |   const input={law_name:'Fixture',law_id:'1',event_dates:{transfer:'2025-01-01',contract:'2024-01-01'}};
  43 |   for(hang of [false,true]) {
  44 |     const r=await verifier.check(input);assert.equal(r.source_access,'available');assert.equal(r.version_selection,'current_candidate');assert.equal(r.evaluation_timezone,'Asia/Seoul');
  45 |     assert.equal(r.historical_access,'partial');assert.equal(r.historical_observations[0].source_access,'available');assert.equal(r.historical_observations[1].source_access,'unavailable');assert.ok(r.current_result);
  46 |   }
  47 | });
  48 | test('effective date switches at Korea midnight, not UTC midnight',async()=>{
  49 |   let at=0;
  50 |   const verifier=new SourceVerifier(()=>({listTools:async()=>({}),close:async()=>{},callTool:async()=>({result:{content:[{type:'text',text:'법령명: Fixture\n시행일: 20260919'}]}})}),()=>at);
  51 |   for(const [time,expected] of [['2026-09-18T23:59:59+09:00','future'],['2026-09-19T00:00:00+09:00','current_candidate'],['2026-09-19T08:59:59+09:00','current_candidate'],['2026-09-19T09:00:00+09:00','current_candidate']]){
  52 |     at=Date.parse(time);assert.equal((await verifier.check({law_name:'Fixture',law_id:'1'})).version_selection,expected);
  53 |   }
  54 | });
  55 |
```

## tests/review-regressions.test.mjs
SHA256: f22ee2e0f41c48a5e58cddebe7dbed7841820949d9b38b2cb68a0ae09e07c346
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
  89 |   const diagnostic={isError:true,content:[{type:'text',text:`PUBLIC_SYNTHETIC_EVENT_DATE_REQUIRED https://source.invalid?OC=${secret}`}],structuredContent:{required:['event_date'],headers:{authorization:secret},stack:secret,detail:'safe public fixture'},_meta:{token:secret}};
  90 |   const f=await fixture(t,{env:{LAW_OC:secret},error:new LawMcpError(502,'MCP_TOOL_ERROR','exception message must remain private',diagnostic)});
  91 |   const rest=await f.request('/api/analyze',{query:'fixture'});assert.equal(rest.status,502);assert.deepEqual(rest.body.result.structuredContent.required,['event_date']);assert.match(rest.body.result.content[0].text,/PUBLIC_SYNTHETIC/);
  92 |   assert.ok(!JSON.stringify(rest).includes(secret));assert.ok(!JSON.stringify(rest).includes('exception message'));
  93 |   const client=new Client({name:'error-contract',version:'1'});t.after(()=>client.close());
  94 |   await client.connect(new SSEClientTransport(new URL(f.base+'/sse'),{requestInit:{headers:{authorization:'Bearer alice'}}}),{timeout:3000});
  95 |   const mcp=await client.callTool({name:'search_law',arguments:{query:'fixture'}});assert.equal(mcp.isError,true);assert.deepEqual(mcp.structuredContent.required,['event_date']);assert.match(mcp.content[0].text,/PUBLIC_SYNTHETIC/);assert.ok(!JSON.stringify(mcp).includes(secret));assert.equal(mcp.structuredContent.stack,undefined);
  96 | });
  97 | test('tool diagnostics bound oversized data and omit credential labels and internal traces',()=>{
  98 |   const result=safeToolDiagnostic({isError:true,content:[{type:'text',text:'PUBLIC_FIXTURE\nAuthorization: Bearer fixture-unknown-value\n    at /internal/private.js:10\nSUPABASE_SECRET=unconfigured-sensitive-value'}],structuredContent:{required:['event_date'],environment:{secret:'hidden'},large:'z'.repeat(20000)}},{});
  99 |   const json=JSON.stringify(result);assert.ok(json.includes('PUBLIC_FIXTURE'));assert.ok(!json.includes('fixture-unknown-value'));assert.ok(!json.includes('unconfigured-sensitive-value'));assert.ok(!json.includes('/internal/private.js'));assert.ok(Buffer.byteLength(json)<=16000);
 100 | });
 101 | test('legacy automatic PR paths stay closed and unavailable durable intake never reports success',async t=>{
 102 |   const f=await fixture(t);
 103 |   assert.equal((await f.request('/api/evolve',{issue_summary:'old'})).status,410);
 104 |   assert.equal((await f.request('/api/failures',{})).status,503);
 105 | });
 106 | test('durable service receives verified actor and DB error is not success',async t=>{
 107 |   let actor;const f=await fixture(t,{failures:{submit:async(a)=>{actor=a;throw new ServiceError(503,'DB_UNAVAILABLE');},status:async()=>({})}});
 108 |   assert.equal((await f.request('/api/failures',{proposer_name:'bob'})).status,503);assert.equal(actor.id,'alice');
 109 | });
 110 | test('real MCP SSE and messages require matching authenticated principal, preserve upstream result',async t=>{
 111 |   const f=await fixture(t);let session;
 112 |   const client=new Client({name:'review',version:'1'});
 113 |   const transport=new SSEClientTransport(new URL(f.base+'/sse'),{requestInit:{headers:{authorization:'Bearer alice'}},fetch:async(url,init)=>{
 114 |     if(String(url).includes('/messages?')) session=new URL(url).searchParams.get('sessionId');return fetch(url,init);
 115 |   }});
 116 |   t.after(()=>client.close());await client.connect(transport,{timeout:3000});
 117 |   const catalog=await client.listTools();assert.ok(catalog.tools.some(x=>x.name==='validate_legal_draft'));
 118 |   assert.equal((await f.request('/messages?sessionId='+session,{jsonrpc:'2.0',method:'ping',id:20},'Bearer bob')).status,404);
 119 |   const r=await client.callTool({name:'search_law',arguments:{query:'law'}});assert.equal(r.structuredContent.law,'fixture');assert.equal(r._meta.upstream,'preserved');
 120 |   const invalid=await client.callTool({name:'validate_tax_draft',arguments:{draft_answer:'law',force:'false'}});assert.equal(invalid.isError,true);
 121 |   const old=await client.callTool({name:'propose_tax_rule',arguments:{}});assert.equal(old.isError,true);
 122 | });
 123 | test('foreign browser Origin and oversized body are rejected',async t=>{
 124 |   const f=await fixture(t);assert.equal((await f.request('/api/tools',undefined,'Bearer alice',{origin:'https://evil.invalid'})).status,403);
 125 |   assert.equal((await f.request('/api/analyze',{query:'x'.repeat(300000)})).status,413);
 126 | });
 127 | test('all ten rules have executable missing-fact paths; FC08-10 are no longer silent passes',()=>{
 128 |   const engine=new GateEngine();assert.equal(engine.rules.length,10);
 129 |   for(const rule of engine.rules){const r=engine.validate({draft_answer:rule.cues[0]},'fixture');assert.equal(r.checks.find(x=>x.id===rule.id).status,'needs_info');assert.equal(r.passed,false);}
 130 |   const result=engine.validate({draft_answer:'종전 취득원가 권리가액 분담금 전액을 시가로 안분'},'fixture');
 131 |   assert.ok(['FC-08','FC-09','FC-10'].every(id=>result.checks.some(c=>c.case_id===id)));
 132 | });
 133 | test('empty checks/skips/unverified legal basis cannot become passed; force preserves completed failed arithmetic',()=>{
 134 |   const e=new GateEngine();assert.equal(e.validate({draft_answer:'hello'},'v').coverage,'no_coverage');
 135 |   assert.throws(()=>e.validate({draft_answer:''},'v'));assert.throws(()=>new GateEngine('missing-rules-directory'));
 136 |   const normal=e.validate({draft_answer:'arithmetic',facts:{allocation:{total:100,parts:[60,60]}}},'v');assert.equal(normal.blocked,true);assert.equal(normal.assessment_complete,true);
 137 |   const forced=e.validate({draft_answer:'arithmetic',facts:{allocation:{total:100,parts:[60,60]}},force:true,bypass_reason:'review exception'},'v');
 138 |   assert.equal(forced.blocked,false);assert.equal(forced.assessment_complete,true);assert.equal(forced.scoped_pass,false);assert.equal(forced.passed,false);
 139 |   const skipped=e.validate({draft_answer:'분담금',skip_gates:['QG-COST-03'],bypass_reason:'review exception'},'v');assert.equal(skipped.assessment_complete,false);
 140 |   const unrelatedSkip=e.validate({draft_answer:'arithmetic',facts:{allocation:{total:100,parts:[60,60]}},skip_gates:['QG-COST-03'],bypass_reason:'skip only contribution research'},'v');
 141 |   assert.equal(unrelatedSkip.blocked,true,'skipping a legal research question cannot disable an executed arithmetic failure');assert.equal(unrelatedSkip.scoped_pass,false);
 142 |   const revised=e.validate({draft_answer:'different'},'v');assert.notEqual(normal.draft_hash,revised.draft_hash);
 143 |   const exact='  original draft  \n';assert.equal(e.validate({draft_answer:exact},'v').draft_hash,digest(exact));
 144 |   assert.notEqual(e.validate({draft_answer:exact},'v').draft_hash,e.validate({draft_answer:exact.trim()},'v').draft_hash);
 145 |   assert.throws(()=>e.validate({draft_answer:'   \n'},'v'));
 146 | });
 147 | test('health records release and rule fingerprints',async t=>{const f=await fixture(t);const r=await f.request('/health');assert.equal(r.body.mcp_release,'4.13.0');assert.match(r.body.rules_version,/^[a-f0-9]{64}$/);});
 148 |
```

## tests/mcp-client.test.mjs
SHA256: 537c3952af9411c46079df956ae75bb98b31c0eaafdc1308f4eb84ca39c62e33
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
  67 |
  68 | test('a crashed child is reported as failure and does not poison later requests', async t => {
  69 |   const client = fixture(t);
  70 |   await assert.rejects(client.callTool('search_law', { query: '__crash__' }), error => error.status === 502);
  71 |   const next = await client.callTool('search_law', { query: 'ok' });
  72 |   assert.equal(next.result.structuredContent.callNumber, 1);
  73 | });
  74 |
  75 | test('MCP capacity remains bounded independently of HTTP connection lifetime', async t => {
  76 |   const client = fixture(t);
  77 |   const requests = Array.from({ length: 3 }, () => client.callTool('search_law', { query: '__slow__' }));
  78 |   try {
  79 |     await assert.rejects(client.callTool('search_law', { query: 'excess' }), error => error.status === 429);
  80 |   } finally {
  81 |     await Promise.all(requests);
  82 |   }
  83 |   assert.equal((await client.callTool('search_law', { query: 'ok' })).result.structuredContent.callNumber, 4);
  84 | });
  85 |
  86 | test('missing executable and stalled initialization fail within the startup deadline', async t => {
  87 |   const options = koreanLawOptionsFromEnv({ LAW_OC: 'fixture' });
  88 |   const missing = fixture(t, { server: { ...options.server, command: 'missing-legal-harness-test-executable' } });
  89 |   await assert.rejects(missing.listTools(), error => error.status === 503);
  90 |   const stalled = fixture(t, {
  91 |     server: { ...options.server, command: process.execPath, args: [fixturePath, '--hang-start'] },
  92 |     connectTimeoutMs: 100,
  93 |   });
  94 |   const started = Date.now();
  95 |   await assert.rejects(stalled.listTools(), error => error.status === 503);
  96 |   assert.ok(Date.now() - started < 6000);
  97 | });
  98 |
  99 | test('closing the client reaps its child and prevents accidental respawn', async t => {
 100 |   const client = fixture(t);
 101 |   const result = await client.callTool('search_law', { query: 'ok' });
 102 |   await client.close();
 103 |   assert.throws(() => process.kill(result.result.structuredContent.pid, 0), { code: 'ESRCH' });
 104 |   await assert.rejects(client.listTools(), error => error.code === 'MCP_CLOSED');
 105 | });
 106 |
 107 | test('only explicit law settings reach the child, and absent LAW_OC cannot produce legal data', async t => {
 108 |   const keys = ['SUPABASE_ANON_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS'];
 109 |   const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
 110 |   t.after(() => {
 111 |     for (const key of keys) {
 112 |       if (before[key] === undefined) delete process.env[key];
 113 |       else process.env[key] = before[key];
 114 |     }
 115 |   });
 116 |   process.env.SUPABASE_ANON_KEY = 'must-not-inherit';
 117 |   process.env.GITHUB_TOKEN = 'must-not-inherit';
 118 |   process.env.NODE_OPTIONS = '--stack-trace-limit=2';
 119 |   const client = fixture(t);
 120 |   const result = await client.callTool('search_law', { query: 'ok' });
 121 |   assert.equal(result.result.structuredContent.inheritedSecrets, false);
 122 |   assert.equal(result.result.structuredContent.hasLawKey, true);
 123 |   const noKey = new KoreanLawClient(koreanLawOptionsFromEnv({}));
 124 |   t.after(() => noKey.close());
 125 |   await assert.rejects(noKey.callTool('search_law', { query: 'ok' }), error => error.code === 'MCP_NOT_CONFIGURED');
 126 | });
 127 |
 128 | test('installed korean-law-mcp release starts over stdio and advertises real tool schemas without API calls', async t => {
 129 |   const client = new KoreanLawClient(koreanLawOptionsFromEnv({}));
 130 |   t.after(() => client.close());
 131 |   const catalog = await client.listTools();
 132 |   assert.equal(catalog.server.name, 'korean-law');
 133 |   for (const name of ['legal_research', 'search_law', 'get_law_text', 'search_decisions', 'get_decision_text']) {
 134 |     assert.ok(catalog.tools.some(tool => tool.name === name && tool.inputSchema.type === 'object'), name);
 135 |   }
 136 | });
 137 |
 138 | test('deployment release file selects the verified upstream executable and rejects conflicting manual settings', async t => {
 139 |   const directory = await mkdtemp(join(tmpdir(), 'legal-harness-release-'));
 140 |   t.after(async () => {
 141 |     const target = await realpath(directory);
 142 |     assert.equal(dirname(target), await realpath(tmpdir()));
 143 |     assert.ok(basename(target).startsWith('legal-harness-release-'));
 144 |     await rm(target, { recursive: true, force: true });
 145 |   });
 146 |   const entrypoint = fileURLToPath(import.meta.resolve('korean-law-mcp'));
 147 |   const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('korean-law-mcp')), 'utf8'));
 148 |   const releaseFile = join(directory, 'active.json');
 149 |   await writeFile(releaseFile, JSON.stringify({ version: metadata.version, entrypoint }));
 150 |   const env = { KOREAN_LAW_MCP_RELEASE_FILE: releaseFile };
 151 |   const options = koreanLawOptionsFromEnv(env);
 152 |   assert.equal(options.server.args[0], entrypoint);
 153 |   assert.equal(options.releaseVersion, metadata.version);
 154 |   assert.throws(() => koreanLawOptionsFromEnv({ ...env, KOREAN_LAW_MCP_ARGS: '[]' }), /not both/);
 155 |   const client = new KoreanLawClient(options);
 156 |   t.after(() => client.close());
 157 |   assert.equal((await client.listTools()).server.version, metadata.version);
 158 | });
 159 |
 160 | test('a process whose version differs from its release manifest cannot initialize successfully', async t => {
 161 |   const client = fixture(t, { releaseVersion: '9.9.9' });
 162 |   await assert.rejects(client.listTools(), error => error.code === 'MCP_UNAVAILABLE');
 163 | });
 164 |
```

## tests/fixtures/law-mcp-server.mjs
SHA256: 1a9114fddb58804aa67f735716285fc330c72325d5ed0fd0dc8ad0dcdfab25f6
```text
   1 | // A real JSON-RPC stdio peer. It never calls any external network service.
   2 | import { Server } from '@modelcontextprotocol/sdk/server/index.js';
   3 | import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
   4 | import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
   5 |
   6 | if (process.argv.includes('--hang-start')) {
   7 |   setInterval(() => {}, 1000);
   8 | } else {
   9 |   const startDelay=process.argv.find(a=>a.startsWith('--start-delay='));
  10 |   if(startDelay)await new Promise(r=>setTimeout(r,Number(startDelay.split('=')[1])));
  11 |   const server = new Server({ name: 'law-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  12 |   let lists = 0;
  13 |   let calls = 0;
  14 |   server.setRequestHandler(ListToolsRequestSchema, async request => {
  15 |     lists++;
  16 |     const names = request.params?.cursor === 'second' ? ['search_law'] : ['legal_research', 'get_law_text'];
  17 |     return {
  18 |       tools: names.map(name => ({ name, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } })),
  19 |       ...(request.params?.cursor ? {} : { nextCursor: 'second' }),
  20 |     };
  21 |   });
  22 |   server.setRequestHandler(CallToolRequestSchema, async request => {
  23 |     const callNumber = ++calls;
  24 |     const args = request.params.arguments ?? {};
  25 |     if (args.query === '__crash__') process.exit(12);
  26 |     if (args.query === '__hang__') return new Promise(() => {});
  27 |     if (args.query === '__invalid__') throw new McpError(ErrorCode.InvalidParams, 'Fixture invalid args');
  28 |     if (args.query === '__error__') return { isError: true, content: [{ type: 'text', text: 'Fixture upstream failure' }] };
  29 |     if (args.query === '__slow__') await new Promise(resolve => setTimeout(resolve, 250));
  30 |     if (args.query === '__budget_slow__') await new Promise(resolve => setTimeout(resolve, 1500));
  31 |     return {
  32 |       content: [{ type: 'text', text: '법령 조회 fixture' }, {
  33 |         type: 'resource_link', name: '소득세법 fixture', uri: 'https://www.law.go.kr/법령/소득세법',
  34 |       }],
  35 |       structuredContent: {
  36 |         pid: process.pid, lists, callNumber, args,
  37 |         effectiveDate: '20250101',
  38 |         inheritedSecrets: Boolean(process.env.SUPABASE_ANON_KEY || process.env.GITHUB_TOKEN || process.env.NODE_OPTIONS),
  39 |         hasLawKey: Boolean(process.env.LAW_OC),
  40 |       },
  41 |       _meta: { fixture: true },
  42 |     };
  43 |   });
  44 |   await server.connect(new StdioServerTransport());
  45 | }
  46 |
```

## package.json
SHA256: 0e1684007032f06b51dc7c55c38eefeb76c127d100bae74e021cc0c533f84de6
```text
   1 | {
   2 |   "name": "k-tax-agent-backend",
   3 |   "version": "2.2.0",
   4 |   "description": "Production Backend for K-Tax Agent (GCE + Supabase + Express)",
   5 |   "main": "dist/index.js",
   6 |   "bin": {
   7 |     "k-tax-agent-backend": "./scripts/hermes-mcp-bridge.mjs",
   8 |     "taxlab-legal": "./scripts/hermes-mcp-bridge.mjs"
   9 |   },
  10 |   "type": "module",
  11 |   "engines": { "node": ">=22" },
  12 |   "files": ["dist", "rules", "scripts/hermes-mcp-bridge.mjs", "npm-shrinkwrap.json", "LICENSE", "README.md"],
  13 |   "scripts": {
  14 |     "build": "tsc",
  15 |     "review": "tsc && node --test --test-concurrency=1 tests/*.test.mjs",
  16 |     "review:package": "npm run build && node scripts/package-smoke.mjs",
  17 |     "release:verify": "node scripts/verify-release.mjs",
  18 |     "smoke:mcp": "npm run build && node scripts/mcp-smoke.mjs",
  19 |     "mcp:update": "node scripts/mcp-update.mjs",
  20 |     "start": "node dist/index.js",
  21 |     "dev": "tsc --watch",
  22 |     "deploy": "pm2 start ecosystem.config.cjs"
  23 |   },
  24 |   "dependencies": {
  25 |     "@modelcontextprotocol/sdk": "1.30.0",
  26 |     "@octokit/rest": "^21.0.1",
  27 |     "@supabase/supabase-js": "^2.45.0",
  28 |     "dotenv": "^16.4.5",
  29 |     "express": "^4.19.2",
  30 |     "js-yaml": "^5.4.2",
  31 |     "korean-law-mcp": "4.13.0",
  32 |     "zod": "^3.23.8"
  33 |   },
  34 |   "devDependencies": {
  35 |     "@electric-sql/pglite": "0.5.8",
  36 |     "@types/express": "^4.17.21",
  37 |     "@types/js-yaml": "^4.0.9",
  38 |     "@types/node": "^22.0.0",
  39 |     "pm2": "^5.4.2",
  40 |     "typescript": "^5.5.4"
  41 |   }
  42 | }
  43 |
```

## .env.example
SHA256: 1ae72ccb8cc4dd695c8febefbfd227d2cee90547282a4a639b12bf0ff93865fd
```text
   1 | PORT=3000
   2 | HOST=127.0.0.1
   3 | PUBLIC_ORIGIN=https://law.taxlab.kr
   4 | # Existing shared partner key, passed in a header; no default or URL query key.
   5 | TAXLAB_API_KEY=
   6 | SUPABASE_URL=https://your-project.supabase.co
   7 | SUPABASE_PUBLISHABLE_KEY=
   8 | # Legacy anon keys are also supported. Never put a service-role key here.
   9 | SUPABASE_ANON_KEY=
  10 | # Server-only durable intake RPC. Never pass to MCP clients or the upstream child.
  11 | SUPABASE_SERVICE_ROLE_KEY=
  12 |
  13 | # Law Open API's issued OC credential; passed only to the MCP child.
  14 | LAW_OC=
  15 | LAW_API_PROTOCOL=https
  16 | KOREAN_LAW_MCP_CONNECT_TIMEOUT_MS=10000
  17 | # Total child connection + tool call budget (max 45000); cleanup holds its slot.
  18 | KOREAN_LAW_MCP_TIMEOUT_MS=45000
  19 |
  20 | # Optional: use a separate installation maintained by the deployment's update cron.
  21 | # Default: this project's locked korean-law-mcp package, run by the current Node.
  22 | # Command is an executable, not a shell command; args must be a JSON array.
  23 | # KOREAN_LAW_MCP_COMMAND=/usr/bin/node
  24 | # KOREAN_LAW_MCP_ARGS=["/opt/korean-law-mcp/node_modules/korean-law-mcp/build/index.js","--mode","stdio"]
  25 | # KOREAN_LAW_MCP_CWD=/opt/korean-law-mcp
  26 |
  27 | # Deployment cron mode: use this instead of the three manual settings above.
  28 | # Bootstrap creates the file; Express reads it when starting.
  29 | # KOREAN_LAW_MCP_RELEASE_FILE=/opt/legal_harness/.runtime/korean-law/active.json
  30 | # KOREAN_LAW_UPDATE_HEALTH_URL=http://127.0.0.1:3000/health
  31 |
  32 | # Optional upstream request/response budgets (upstream defaults shown).
  33 | MCP_MAX_UPSTREAM_REQUESTS=48
  34 | MCP_MAX_UPSTREAM_BODY_BYTES=2097152
  35 | MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES=8388608
  36 | MCP_MAX_TOOL_RESPONSE_CHARS=50000
  37 |
  38 | # Read-only release verification / trusted coordinator configuration.
  39 | GITHUB_TOKEN=
  40 | GITHUB_OWNER=hyunae52
  41 | GITHUB_REPO=legal_harness
  42 | GITHUB_BASE_BRANCH=main
  43 | GITHUB_OPERATOR=hyunae52
  44 |
  45 | # The automatic repair worker is not enabled. Its AGY tools/credential isolation
  46 | # and hosted runner evidence adapter must be implemented and verified first.
  47 | # No offline heuristic approval, paid fallback, or automatic production activation.
  48 |
```

## docs/reviews/DEPLOYMENT_PRO_REVIEW_2026-09-19.md
SHA256: 3eb17aa004e168c2abc8d667f6a6b5ef47afa6205bfe305e5d595bc67195a780
```text
   1 | # 독립 Pro 코드·배포 검수
   2 |
   3 | - 요청: 수정 후 별도 Pro 모델의 배포 검수.
   4 | - 실행: ChatGPT 새 대화의 모델 선택기 **6 Pro**를 확인하고 코드 스냅샷 첨부.
   5 | - 대화: https://chatgpt.com/c/6aae9b76-b7d8-83e8-b743-71f206c6b9dd
   6 | - 1차 입력 commit: `7309a3776787bd26e58d5137b9122a9904224cab` (로컬 `review/pro-input-20260919` 태그 보존).
   7 | - 입력: [53개 파일의 코드·시험·계획 패킷](DEPLOYMENT_PRO_PACKET_2026-09-19_v1.md), SHA-256 `d04450c0c486944b0ab373c4e9b33733bf8af8b1d408416fc0471203f13c7d4d`.
   8 | - `.env`의 credential 값과 일치하는 내용이 패킷에 없음을 검사했다. 원본 개인 사건 자료를 포함하지 않았다.
   9 | - PR: https://github.com/hyunae52/legal_harness/pull/3 (Draft).
  10 |
  11 | ## 1차 판정
  12 |
  13 | 17분 32초 처리 후 **전체 production NO-GO / 제한 배포 후보 CODE REVISE·배포 HOLD**. 신규 P1은 확정하지 않았고 실제 연결된 경로에서 P2 다섯 건을 확인했다.
  14 |
  15 | Pro는 첨부 53개 파일의 hash 일치를 확인했다. npm registry DNS 오류 때문에 전체 npm 시험을 직접 재실행하지는 못했다. 조건식·날짜 비교·Node requestTimeout 의미에 대한 보조 재현을 수행했다고 밝혔으며, 제출자의 57/57 통과와 자신의 실행 범위를 구분했다. Pro가 전체 서비스를 실행·검증했다는 뜻이 아니다.
  16 |
  17 | | ID | 지적 | 수정 |
  18 | |---|---|---|
  19 | | R1 | 특정 규칙 skip이 무관한 산술 실패의 차단까지 해제 | skip의 범위를 해당 검사에 한정하고 전역 차단 해제는 force/warn만 허용 |
  20 | | R2 | 연혁 일부 실패가 정상 원문과 성공한 연혁까지 유실 | 원문과 역할별 연혁 상태를 분리하고 부분 결과/전체 deadline 실패를 보존 |
  21 | | R3 | 시행일을 UTC 날짜로 비교 | Asia/Seoul 날짜로 비교하고 비교 timezone 명시, 한국 자정 경계 네 시각 시험 |
  22 | | R4 | 서버 연결 10초+호출 45초에 비해 bridge 45초가 짧음 | 서버 연결+호출 총 45초, 연결에 쓴 시간을 차감, 정리까지 슬롯 유지, bridge 응답 60초 |
  23 | | R5 | upstream의 유의미한 오류 내용/구조화 정보가 API에서 유실 | 예상 도구 오류만 제한된 진단으로 보존, credential/내부 필드/trace 제거 및 크기 제한, REST/MCP 시험 |
  24 |
  25 | 추가 보완: SSE 스트림이 열려도 endpoint를 주지 않는 경우 전체 접속 deadline, 공백/줄바꿈까지 포함한 정확한 초안 hash, 게시 tarball의 npm-shrinkwrap과 실제 설치 버전 확인.
  26 |
  27 | ## 미완료와 배포 경계
  28 |
  29 | Pro는 조회 전용 HTTPS 전환까지 AGY 완성을 기다릴 필요는 없다고 구분했다. 자동 수리·승인·게시·배포 실행기를 운영 entrypoint에 새로 연결하라는 요구는 없었다. DB 접수를 켜면 실제 migration/권한/복구 시험이 필요하고, 조회 전용 후보에서 접수를 닫는 선택은 허용했다.
  30 |
  31 | 운영 HTTPS DNS/터널/외부 3000 폐쇄와 안전한 조회 전용 rollback은 아직 미확인이다. 실제 DB migration/복원 및 전체 자기수정 흐름도 미완료이며 이번 결과로 production GO를 만들지 않는다.
  32 |
  33 | 1차 검수 중 GitHub push가 PAT의 workflow scope 부족으로 거부되었다. 실행 workflow를 `deploy/review.workflow.yml.example`로 보존해 나머지를 Draft PR에 게시했다. 원본 검수 입력과 게시 commit의 차이는 이 CI 파일 위치 및 그 사유를 밝힌 문서였고, 당시 runtime/test 코드의 차이는 없었다. **Linux CI는 실행되지 않았다.**
  34 |
  35 | ## 재검수
  36 |
  37 | R1~R5 수정본의 최종 시험과 정확한 commit을 고정한 후 같은 Pro 대화에 한정 재검수한다. 최종 판정과 artifact digest는 응답 수신 후 아래에 기록한다. 이 문구 자체는 재검수 통과 선언이 아니다.
  38 |
```

## Lock proof
{
  "package_lock_sha256": "f728dffab62fc5a1d8792819611e6b6bcf9812f6fece5f9ef7cd17fb0838e950",
  "npm_shrinkwrap_sha256": "f728dffab62fc5a1d8792819611e6b6bcf9812f6fece5f9ef7cd17fb0838e950",
  "equal": true,
  "root": {
    "name": "k-tax-agent-backend",
    "version": "2.2.0",
    "dependencies": {
      "@modelcontextprotocol/sdk": "1.30.0",
      "@octokit/rest": "^21.0.1",
      "@supabase/supabase-js": "^2.45.0",
      "dotenv": "^16.4.5",
      "express": "^4.19.2",
      "js-yaml": "^5.4.2",
      "korean-law-mcp": "4.13.0",
      "zod": "^3.23.8"
    },
    "bin": {
      "k-tax-agent-backend": "scripts/hermes-mcp-bridge.mjs",
      "taxlab-legal": "scripts/hermes-mcp-bridge.mjs"
    },
    "devDependencies": {
      "@electric-sql/pglite": "0.5.8",
      "@types/express": "^4.17.21",
      "@types/js-yaml": "^4.0.9",
      "@types/node": "^22.0.0",
      "pm2": "^5.4.2",
      "typescript": "^5.5.4"
    },
    "engines": {
      "node": ">=22"
    }
  },
  "direct": {
    "@modelcontextprotocol/sdk": {
      "version": "1.30.0",
      "resolved": "https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz",
      "integrity": "sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==",
      "license": "MIT",
      "dependencies": {
        "@hono/node-server": "^1.19.9 || ^2.0.5",
        "ajv": "^8.17.1",
        "ajv-formats": "^3.0.1",
        "content-type": "^1.0.5",
        "cors": "^2.8.5",
        "cross-spawn": "^7.0.5",
        "eventsource": "^3.0.2",
        "eventsource-parser": "^3.0.0",
        "express": "^5.2.1",
        "express-rate-limit": "^8.2.1",
        "hono": "^4.11.4",
        "jose": "^6.1.3",
        "json-schema-typed": "^8.0.2",
        "pkce-challenge": "^5.0.0",
        "raw-body": "^3.0.0",
        "zod": "^3.25 || ^4.0",
        "zod-to-json-schema": "^3.25.1"
      },
      "engines": {
        "node": ">=18"
      },
      "peerDependencies": {
        "@cfworker/json-schema": "^4.1.1",
        "zod": "^3.25 || ^4.0"
      },
      "peerDependenciesMeta": {
        "@cfworker/json-schema": {
          "optional": true
        },
        "zod": {
          "optional": false
        }
      }
    },
    "@octokit/rest": {
      "version": "21.1.1",
      "resolved": "https://registry.npmjs.org/@octokit/rest/-/rest-21.1.1.tgz",
      "integrity": "sha512-sTQV7va0IUVZcntzy1q3QqPm/r8rWtDCqpRAmb8eXXnKkjoQEtFe3Nt5GTVsHft+R6jJoHeSiVLcgcvhtue/rg==",
      "license": "MIT",
      "dependencies": {
        "@octokit/core": "^6.1.4",
        "@octokit/plugin-paginate-rest": "^11.4.2",
        "@octokit/plugin-request-log": "^5.3.1",
        "@octokit/plugin-rest-endpoint-methods": "^13.3.0"
      },
      "engines": {
        "node": ">= 18"
      }
    },
    "@supabase/supabase-js": {
      "version": "2.116.0",
      "resolved": "https://registry.npmjs.org/@supabase/supabase-js/-/supabase-js-2.116.0.tgz",
      "integrity": "sha512-YyWmKXt2NspV9iO8FPnlswUFJIRnrLd3oTCb+3ZyYRuKZtBH0xCUDgnUqoyA0fGUxpM/UhfwDjYf/dht/9bp7g==",
      "license": "MIT",
      "dependencies": {
        "@supabase/auth-js": "2.116.0",
        "@supabase/functions-js": "2.116.0",
        "@supabase/postgrest-js": "2.116.0",
        "@supabase/realtime-js": "2.116.0",
        "@supabase/storage-js": "2.116.0"
      },
      "engines": {
        "node": ">=22.0.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0"
      },
      "peerDependenciesMeta": {
        "@opentelemetry/api": {
          "optional": true
        }
      }
    },
    "dotenv": {
      "version": "16.6.1",
      "resolved": "https://registry.npmjs.org/dotenv/-/dotenv-16.6.1.tgz",
      "integrity": "sha512-uBq4egWHTcTt33a72vpSG0z3HnPuIl6NqYcTrKEg2azoEyl2hpW0zqlxysq2pK9HlDIHyHyakeYaYnSAwd8bow==",
      "license": "BSD-2-Clause",
      "engines": {
        "node": ">=12"
      },
      "funding": {
        "url": "https://dotenvx.com"
      }
    },
    "express": {
      "version": "4.22.2",
      "resolved": "https://registry.npmjs.org/express/-/express-4.22.2.tgz",
      "integrity": "sha512-IuL+Elrou2ZvCFHs18/CIzy2Nzvo25nZ1/D2eIZlz7c+QUayAcYoiM2BthCjs+EBHVpjYjcuLDAiCWgeIX3X1Q==",
      "license": "MIT",
      "dependencies": {
        "accepts": "~1.3.8",
        "array-flatten": "1.1.1",
        "body-parser": "~1.20.5",
        "content-disposition": "~0.5.4",
        "content-type": "~1.0.4",
        "cookie": "~0.7.1",
        "cookie-signature": "~1.0.6",
        "debug": "2.6.9",
        "depd": "2.0.0",
        "encodeurl": "~2.0.0",
        "escape-html": "~1.0.3",
        "etag": "~1.8.1",
        "finalhandler": "~1.3.1",
        "fresh": "~0.5.2",
        "http-errors": "~2.0.0",
        "merge-descriptors": "1.0.3",
        "methods": "~1.1.2",
        "on-finished": "~2.4.1",
        "parseurl": "~1.3.3",
        "path-to-regexp": "~0.1.12",
        "proxy-addr": "~2.0.7",
        "qs": "~6.15.1",
        "range-parser": "~1.2.1",
        "safe-buffer": "5.2.1",
        "send": "~0.19.0",
        "serve-static": "~1.16.2",
        "setprototypeof": "1.2.0",
        "statuses": "~2.0.1",
        "type-is": "~1.6.18",
        "utils-merge": "1.0.1",
        "vary": "~1.1.2"
      },
      "engines": {
        "node": ">= 0.10.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "js-yaml": {
      "version": "5.4.2",
      "resolved": "https://registry.npmjs.org/js-yaml/-/js-yaml-5.4.2.tgz",
      "integrity": "sha512-m+aqu+LwO1O6sIopafj8HUVl5aawITwZQe/yHpMCKjaWBaA/d07B/QdMb3529REftiU+RMMHL3Vlsw3hON7vWg==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/puzrin"
        },
        {
          "type": "github",
          "url": "https://github.com/sponsors/nodeca"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "argparse": "^2.0.1"
      },
      "bin": {
        "js-yaml": "bin/js-yaml.mjs"
      }
    },
    "korean-law-mcp": {
      "version": "4.13.0",
      "resolved": "https://registry.npmjs.org/korean-law-mcp/-/korean-law-mcp-4.13.0.tgz",
      "integrity": "sha512-XpJKpQlwgrBzaf/I3kH1mZtRgs/8UKYNzvIrjJ6RHBqwhUCgo4Mty70AZA57p6Pma/lKxOGe9XAsbd1vw2RQeQ==",
      "license": "MIT",
      "dependencies": {
        "@modelcontextprotocol/sdk": "^1.27.1",
        "@xmldom/xmldom": "^0.9.8",
        "commander": "^14.0.3",
        "dotenv": "^17.3.1",
        "express": "^5.2.1",
        "kordoc": "^4.7.2",
        "pdfjs-dist": "4.10.38",
        "zod": "^4.0.0"
      },
      "bin": {
        "korean-law": "build/cli.js",
        "korean-law-mcp": "build/index.js"
      },
      "engines": {
        "node": ">=20.19.0"
      }
    },
    "zod": {
      "version": "3.25.76",
      "resolved": "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz",
      "integrity": "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==",
      "license": "MIT",
      "funding": {
        "url": "https://github.com/sponsors/colinhacks"
      }
    }
  }
}
