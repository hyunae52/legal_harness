import express, { type Request, type Response, type NextFunction } from 'express';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { LawMcpError, type KoreanLawClient } from './koreanLawClient.js';
import { type Actor, AnalyzeSchema, DraftSchema, type FailureService, ServiceError } from './contracts.js';
import { GateEngine } from './gates.js';
import { createAuthenticator } from './auth.js';
import { retrievalEnvelope } from './evidence.js';
import { type SourceVerifier } from './sourceVerifier.js';
import { safeToolDiagnostic } from './errorDiagnostics.js';
import { landingHeaders, landingHtml } from './landing.js';
import { actionsSchema, antigravityConfig, desktopConfig, geminiConfig, gptInstructions, setupMarkdown } from './setup.js';
import { type CorrectionService } from './corrections.js';
import { correctionInputs, correctionInstructions } from './correctionMeta.js';

interface Options {
  law: Pick<KoreanLawClient, 'listTools' | 'callTool' | 'close' | 'releaseVersion'>;
  env?: NodeJS.ProcessEnv;
  authenticate?: (request: Request) => Promise<Actor>;
  gates?: GateEngine;
  failures?: FailureService;
  sources?: SourceVerifier;
  corrections?: CorrectionService;
  maxActive?: number;
  maxSessions?: number;
  sessionIdleMs?: number;
}
export function createApp(options: Options) {
  const env = options.env ?? process.env;
  const auth = options.authenticate ?? createAuthenticator(env);
  const gates = options.gates ?? new GateEngine();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  const sessions = new Map<string, { actor: Actor; server: Server; transport: SSEServerTransport; touched: number }>();
  let active = 0, authActive = 0, stopping = false;
  const version = options.law.releaseVersion ?? 'unidentified';
  const maxActive = options.maxActive ?? 3;
  const work = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopping) throw new ServiceError(503, 'SHUTTING_DOWN');
    if (active >= maxActive) throw new ServiceError(429, 'AT_CAPACITY');
    active++;
    try { return await operation(); } finally { active--; }
  };
  const errorBody = (error: unknown) => {
    if (error instanceof z.ZodError) return { status: 400, body: { code: 'INVALID_INPUT', fields: error.issues.map(i => i.path.join('.')) } };
    if (error instanceof LawMcpError && error.code==='MCP_TOOL_ERROR' && error.result) return {status:error.status,body:{code:error.code,result:safeToolDiagnostic(error.result,env)}};
    if (error instanceof ServiceError || error instanceof LawMcpError) return { status: error.status, body: { code: error.code } };
    return { status: 500, body: { code: 'INTERNAL_ERROR' } };
  };
  const fail = (res: Response, error: unknown) => {
    if (res.headersSent) { res.end(); return; }
    const r = errorBody(error);
    if (r.status === 429) res.set('Retry-After', '5');
    res.status(r.status).json(r.body);
  };
  const protectedRoute = (handler: (req: Request, res: Response, actor: Actor) => Promise<unknown>) => (req: Request, res: Response) => {
    void (async () => {
      if (stopping || authActive >= 20) throw new ServiceError(429, 'AT_CAPACITY');
      authActive++;
      let actor: Actor;
      try { actor = await auth(req); } finally { authActive--; }
      const origin = req.get('origin');
      if (origin && origin !== (env.PUBLIC_ORIGIN || 'https://law.taxlab.kr')) throw new ServiceError(403, 'ORIGIN_REJECTED');
      await handler(req, res, actor);
    })().catch(error => fail(res, error));
  };
  const validate = (input: unknown) => gates.validate(DraftSchema.parse(input), version);
  const retrieve = async (name: string, args: Record<string, unknown>, dates: Record<string, string> = {}, correctionQuery = String(args.query ?? '')) => {
    const result = await options.law.callTool(name, args);
    const evidence = retrievalEnvelope(name, args, result.result, version, dates);
    return { ...result, evidence, corrections: options.corrections?.search(correctionQuery) ?? { status: 'unavailable', items: [] } };
  };
  const submit = (actor: Actor, input: unknown) => {
    if (!options.failures) throw new ServiceError(503, 'MAINTENANCE_UNAVAILABLE');
    return options.failures.submit(actor, input);
  };
  app.get('/', (_req, res) => res.set(landingHeaders).type('html').send(landingHtml));
  const corrections = () => {
    if (!options.corrections) throw new ServiceError(503, 'CORRECTION_PR_UNAVAILABLE');
    return options.corrections;
  };
  app.post('/api/corrections/prepare', protectedRoute(async (req, res, actor) => res.json(await work(() => corrections().prepare(actor, req.body)))));
  app.post('/api/corrections/create', protectedRoute(async (req, res, actor) => res.json(await work(() => corrections().confirm(actor, req.body)))));
  app.post('/api/corrections/status', protectedRoute(async (req, res, actor) => res.json(await work(() => corrections().status(actor, z.object({ proposal_id: z.string().uuid() }).strict().parse(req.body).proposal_id)))));
  const publicHeaders = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
  app.get('/setup.md', (_req, res) => res.set(publicHeaders).type('text/plain').send(setupMarkdown));
  app.get('/openapi.json', (_req, res) => res.set(publicHeaders).json(actionsSchema));
  for (const [name, type, body] of [
    ['gemini-settings.json', 'application/json', geminiConfig],
    ['antigravity-mcp.json', 'application/json', antigravityConfig],
    ['chatgpt-desktop.toml', 'text/plain', desktopConfig],
    ['chatgpt-actions.json', 'application/json', JSON.stringify(actionsSchema, null, 2)],
    ['chatgpt-instructions.txt', 'text/plain', gptInstructions],
  ]) app.get('/downloads/' + name, (_req, res) => res.set(publicHeaders).attachment(name).type(type).send(body));
  for (const name of ['taxlab-law.mcpb', 'taxlab-bridge.zip']) app.get('/downloads/' + name, (_req, res) => {
    res.set(publicHeaders).attachment(name).type(name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream');
    res.sendFile(fileURLToPath(new URL('./downloads/taxlab-law.mcpb', import.meta.url)), error => {
      if (error && !res.headersSent) {
        res.removeHeader('Content-Disposition');
        res.status(503).json({ code: 'INSTALLER_UNAVAILABLE' });
      } else if (error) res.destroy();
    });
  });
  app.get('/health', (_req, res) => res.json({ status: stopping ? 'stopping' : 'ok', version: '2.2.0', active_requests: active,
    mcp_release: options.law.releaseVersion ?? null, rules_version: gates.version, maintenance: options.failures ? 'intake_only' : 'unavailable', correction_pr: options.corrections ? 'available' : 'unavailable' }));
  app.get('/api/tools', protectedRoute(async (_req, res) => res.json({ status: 'success', data: await work(() => options.law.listTools()) })));
  app.post('/api/validate', protectedRoute(async (req, res) => res.json(await work(async () => validate(req.body)))));
  app.post('/api/sources/check', protectedRoute(async (req,res) => {
    if(!options.sources) throw new ServiceError(503,'SOURCE_VERIFIER_UNAVAILABLE');
    res.json(await work(()=>options.sources!.check(req.body)));
  }));
  app.post('/api/analyze', protectedRoute(async (req, res) => {
    const data = AnalyzeSchema.parse(req.body);
    return work(async () => {
      const quality = data.draft_answer ? validate({ draft_answer: data.draft_answer, query: data.query, facts: data.facts,
        skip_gates: data.skip_gates, mode: data.mode, force: data.force, bypass_reason: data.bypass_reason }) : null;
      if (quality?.blocked) return res.status(422).json({ code: 'DRAFT_CHECK_FAILED', quality_gate: quality });
      const args = { ...data.arguments };
      if (['legal_research', 'search_law', 'search_decisions'].includes(data.tool)) args.query = data.query;
      return res.json({ status: 'success', data: await retrieve(data.tool, args, data.event_dates, data.query), quality_gate: quality });
    });
  }));
  app.post('/api/failures', protectedRoute(async (req, res, actor) => res.status(202).json(await work(() => submit(actor, req.body)))));
  app.get('/api/failures/:id', protectedRoute(async (req, res, actor) => {
    const id = z.string().uuid().parse(req.params.id);
    if (!options.failures) throw new ServiceError(503, 'MAINTENANCE_UNAVAILABLE');
    res.json(await work(() => options.failures!.status(actor, id)));
  }));
  app.post('/api/evolve', protectedRoute(async () => { throw new ServiceError(410, 'USE_SUBMIT_FAILURE'); }));

  const custom: Tool[] = [
    { name: 'prepare_correction_pr', description: correctionInstructions, inputSchema: correctionInputs.prepare,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    { name: 'create_correction_pr', description: '사용자가 공개 preview와 저장소를 보고 PR 생성에 동의한 뒤에만 호출하세요. 실제 교정 자료 draft PR을 생성합니다. 수정·머지 승인이 아닙니다. 응답 유실 시 get_correction_pr로 기존 제안을 조회하세요.', inputSchema: correctionInputs.confirm,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    { name: 'get_correction_pr', description: '기존 교정 제안의 PR 생성 결과·검수 대기·머지 상태를 조회합니다. 새 PR을 만들지 않습니다.', inputSchema: correctionInputs.status,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    { name: 'find_legal_corrections', description: 'GitHub에서 머지된 법령·해석 교정 자료를 질문 키워드로 찾습니다. 출처 최신성·사건 적용과 독립 AI 검수는 별도로 확인해야 합니다.', inputSchema: correctionInputs.search,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    { name:'check_legal_sources',description:'새 upstream 프로세스로 공식 법령 원문과 역할별 사건일 연혁을 다시 조회합니다. 부칙 해석과 예규 유효성은 별도 미검수입니다.',inputSchema:{type:'object',properties:{law_name:{type:'string'},law_id:{type:'string'},article:{type:'string'},event_dates:{type:'object'}},required:['law_name','law_id'],additionalProperties:false}},
    ...['validate_legal_draft', 'validate_tax_draft'].map(name => ({ name, description: '제출 초안의 제한된 검사. needs_info/unverified는 법률 통과가 아닙니다. 최종 답변 변경 시 재검사하세요.', inputSchema: { type: 'object' as const, properties: {
      draft_answer: { type: 'string' }, query: { type: 'string' }, facts: { type: 'object' }, skip_gates: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['strict', 'warn'] }, force: { type: 'boolean' }, bypass_reason: { type: 'string' }
    }, required: ['draft_answer'], additionalProperties: false } })),
    { name: 'submit_failure', description: '실패를 영속 접수합니다. 접수는 AI 승인이나 PR 생성을 뜻하지 않습니다. 공유 key로는 사전 정의된 합성 사례만 접수할 수 있습니다.', inputSchema: { type: 'object', properties: {
      request_id: { type: 'string', format: 'uuid' }, case_id: { type: 'string' }, category: { type: 'string', enum: ['retrieval', 'validation', 'transport'] }, expected: { type: 'string', enum: ['needs_info', 'retrieval', 'reject_invalid_input'] }, actual: { type: 'string', enum: ['passed', 'empty', 'error', 'accepted_invalid_input'] }
    }, required: ['request_id', 'case_id', 'category', 'expected', 'actual'], additionalProperties: false } },
  ];
  function mcpServer(actor: Actor) {
    const server = new Server({ name: 'taxlab-legal-harness', version: '2.2.0' }, { capabilities: { tools: {} },
      instructions: '법령 도구 결과는 조회 자료입니다. 사건 기준일·연혁·부칙·후속 해석을 확인하세요. 초안은 validate_legal_draft로 검사하고 미검수/누락 사실을 사용자에게 알리세요. 검사하지 않은 최종 답변을 검수 완료로 표시하지 마세요. ' + correctionInstructions });
    server.setRequestHandler(ListToolsRequestSchema, () => work(async () => ({ tools: [...(await options.law.listTools()).tools.filter(t => !custom.some(c => c.name === t.name)).map(t => ({...t, description: (t.description ?? '') + '\n반박·새 근거로 기존 답변을 정정하면 prepare_correction_pr로 제안 내용을 준비하고 사용자에게 PR 생성을 물어보세요.'})), ...custom] })));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        return await work(async () => {
          const { name, arguments: args = {} } = request.params;
          if (['prepare_correction_pr', 'create_correction_pr', 'get_correction_pr', 'find_legal_corrections'].includes(name)) {
            const service = corrections();
            const data = name === 'prepare_correction_pr' ? await service.prepare(actor, args)
              : name === 'create_correction_pr' ? await service.confirm(actor, args)
              : name === 'get_correction_pr' ? await service.status(actor, z.object({ proposal_id: z.string().uuid() }).strict().parse(args).proposal_id)
              : service.search(z.object({ query: z.string().min(1).max(20000) }).strict().parse(args).query);
            return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
          }
          if(name==='check_legal_sources') {
            if(!options.sources) throw new ServiceError(503,'SOURCE_VERIFIER_UNAVAILABLE');
            const data=await options.sources.check(args);
            return {content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data};
          }
          if (name === 'propose_tax_rule') throw new ServiceError(410, 'USE_SUBMIT_FAILURE');
          if (name === 'validate_tax_draft' || name === 'validate_legal_draft' || name === 'submit_failure') {
            const data = name === 'submit_failure' ? await submit(actor, args) : validate(args);
            return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
          }
          const data = await retrieve(name, args);
          return { ...data.result, content: [...data.result.content, ...(data.corrections.items.length ? [{ type: 'text' as const, text: JSON.stringify({ merged_correction_notes: data.corrections }) }] : [])],
            _meta: { ...data.result._meta, 'legal-harness/evidence': data.evidence, 'legal-harness/corrections': data.corrections } };
        });
      } catch (error) {
        if(error instanceof LawMcpError && error.code==='MCP_TOOL_ERROR' && error.result)return {...safeToolDiagnostic(error.result,env),_meta:{'legal-harness/error':error.code}};
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorBody(error).body) }] };
      }
    });
    return server;
  }
  app.get('/sse', protectedRoute(async (_req, res, actor) => {
    if (sessions.size >= (options.maxSessions ?? 20) || [...sessions.values()].filter(s => s.actor.id === actor.id).length >= 5) throw new ServiceError(429, 'SESSION_CAPACITY');
    const transport = new SSEServerTransport('/messages', res);
    const server = mcpServer(actor);
    sessions.set(transport.sessionId, { actor, server, transport, touched: Date.now() });
    res.once('close', () => { sessions.delete(transport.sessionId); void server.close(); });
    try { await server.connect(transport); } catch (error) { sessions.delete(transport.sessionId); await server.close(); throw error; }
  }));
  app.post('/messages', protectedRoute(async (req, res, actor) => {
    const id = z.string().uuid().parse(req.query.sessionId);
    const session = sessions.get(id);
    if (!session || session.actor.id !== actor.id) throw new ServiceError(404, 'SESSION_NOT_FOUND');
    if (Date.now() - session.touched > (options.sessionIdleMs ?? 900_000)) { await session.server.close(); sessions.delete(id); throw new ServiceError(404, 'SESSION_EXPIRED'); }
    session.touched = Date.now();
    await session.transport.handlePostMessage(req, res, req.body);
  }));
  const timer = setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.touched > (options.sessionIdleMs ?? 900_000)) { sessions.delete(id); void session.server.close(); }
  }, Math.min(options.sessionIdleMs ?? 900_000, 30_000));
  timer.unref();
  app.use((error: {type?: string}, _req: Request, res: Response, _next: NextFunction) => fail(res, error.type === 'entity.too.large' ? new ServiceError(413, 'BODY_TOO_LARGE') : error instanceof SyntaxError ? new ServiceError(400, 'INVALID_JSON') : error));
  return { app, close: async () => { stopping = true; clearInterval(timer); await Promise.allSettled([...sessions.values()].map(s => s.server.close())); sessions.clear(); await Promise.allSettled([options.law.close(),options.sources?.close()]); } };
}
