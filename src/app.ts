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
import { ResearchService, researchPolicyVersion, type ResearchOptions } from './research.js';
import { researchTools, researchRoutes, researchSchemas, researchInstructions, type ResearchTool } from './researchContracts.js';
import { ResourceBudgets, positiveLimit, type ResourceOptions } from './resourceBudgets.js';
import { serveStateless, type RequestGuard } from './statelessHttp.js';
import { PublicAccess, actorBudgetKey, assertNoPublicSession } from './publicAccess.js';

interface Options {
  law: Pick<KoreanLawClient, 'listTools' | 'callTool' | 'close' | 'releaseVersion'> & { taxlawRelease?: { version?: string; commit: string } | null };
  env?: NodeJS.ProcessEnv;
  authenticate?: (request: Request) => Promise<Actor>;
  gates?: GateEngine;
  failures?: FailureService;
  sources?: SourceVerifier;
  corrections?: CorrectionService;
  maxActive?: number;
  maxSessions?: number;
  sessionIdleMs?: number;
  researchOptions?: ResearchOptions;
  resourceOptions?: ResourceOptions;
}
export function createApp(options: Options) {
  const env = options.env ?? process.env;
  const publicAccess = new PublicAccess(env);
  const budgets = new ResourceBudgets(env, options.resourceOptions);
  const maxActive = positiveLimit(options.maxActive ?? env.TAXLAB_MAX_ACTIVE, 3);
  const maxTransports = positiveLimit(options.maxSessions ?? env.TAXLAB_MAX_TRANSPORTS, 20);
  const maxTransportsPerActor = positiveLimit(env.TAXLAB_MAX_TRANSPORTS_PER_ACTOR, 5);
  const auth = options.authenticate ?? createAuthenticator(env, fetch, publicAccess);
  const gates = options.gates ?? new GateEngine();
  const research = new ResearchService(options.law, options.sources ? input => options.sources!.check(input) : undefined, options.researchOptions);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  const sessions = new Map<string, { actor: Actor; server: Server; transport: SSEServerTransport; touched: number }>();
  let active = 0, authActive = 0, dispatchActive = 0, stopping = false;
  let transportActive = 0;
  const transportActors = new Map<string, number>();
  const admitTransport = (actor: Actor) => {
    const key = actorBudgetKey(actor), current = transportActors.get(key) ?? 0;
    if (transportActive >= maxTransports || current >= maxTransportsPerActor) throw new ServiceError(429, 'SESSION_CAPACITY');
    transportActive++; transportActors.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true; transportActive--;
      const remaining = (transportActors.get(key) ?? 1) - 1;
      if (remaining) transportActors.set(key, remaining); else transportActors.delete(key);
    };
  };
  const version = options.law.releaseVersion ?? 'unidentified';
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
      if (stopping) throw new ServiceError(503, 'SHUTTING_DOWN');
      if (authActive >= 20) throw new ServiceError(429, 'AT_CAPACITY');
      authActive++;
      let actor: Actor;
      try { actor = await auth(req); } finally { authActive--; }
      // Authentication can settle after drain begins. Never dispatch that request.
      if (stopping) throw new ServiceError(503, 'SHUTTING_DOWN');
      const origin = req.get('origin');
      if (origin && origin !== (env.PUBLIC_ORIGIN || 'https://law.taxlab.kr')) throw new ServiceError(403, 'ORIGIN_REJECTED');
      budgets.consume(actor, 'request');
      dispatchActive++;
      try { await handler(req, res, actor); } finally { dispatchActive--; }
    })().catch(error => fail(res, error));
  };
  const validate = (input: unknown) => gates.validate(DraftSchema.parse(input), version);
  const retrieve = async (actor: Actor, name: string, args: Record<string, unknown>, dates: Record<string, string> = {}, correctionQuery = String(args.query ?? '')) => {
    assertNoPublicSession(args);
    budgets.consume(actor, 'lookup');
    const result = await options.law.callTool(name, args);
    const evidence = { ...retrievalEnvelope(name, args, result.result, result.server?.version ?? version, dates),
      upstream_name: result.server?.name ?? 'unidentified' };
    return { ...result, evidence, corrections: options.corrections?.search(correctionQuery) ?? { status: 'unavailable', items: [] } };
  };
  const submit = (actor: Actor, input: unknown) => {
    if (actor.kind === 'anonymous') throw new ServiceError(410, 'USE_CORRECTION_PR');
    if (!options.failures) throw new ServiceError(503, 'MAINTENANCE_UNAVAILABLE');
    return options.failures.submit(actor, input);
  };
  const runResearch = async (name: ResearchTool, actor: Actor, input: unknown) => {
    if (name === 'research_legal_sources') budgets.consume(actor, 'lookup');
    const scoped = publicAccess.scope(actor, input, name === 'start_legal_research');
    assertNoPublicSession(scoped.input);
    return publicAccess.result(await research.run(name, scoped.actor, scoped.input), scoped.token);
  };
  const checkSources = (actor: Actor, input: unknown) => {
    assertNoPublicSession(input);
    if (!options.sources) throw new ServiceError(503, 'SOURCE_VERIFIER_UNAVAILABLE');
    budgets.consume(actor, 'lookup');
    return options.sources.check(input);
  };
  app.get('/', (_req, res) => res.set(landingHeaders).type('html').send(landingHtml));
  const corrections = () => {
    if (!options.corrections) throw new ServiceError(503, 'CORRECTION_PR_UNAVAILABLE');
    return options.corrections;
  };
  const runCorrection = async (name: 'prepare' | 'confirm' | 'status', actor: Actor, input: unknown) => {
    const scoped = publicAccess.scope(actor, input, name === 'prepare');
    assertNoPublicSession(scoped.input);
    const service = corrections();
    const result = name === 'status' ? await service.status(scoped.actor, z.object({ proposal_id: z.string().uuid() }).strict().parse(scoped.input).proposal_id)
      : await service[name](scoped.actor, scoped.input);
    const retry = scoped.token && 'retry' in result && result.retry
      ? { retry: { ...result.retry, arguments: { ...result.retry.arguments, client_session: scoped.token } } } : {};
    return publicAccess.result({ ...result, ...retry }, scoped.token);
  };
  app.post('/api/corrections/prepare', protectedRoute(async (req, res, actor) => res.json(await work(() => runCorrection('prepare', actor, req.body)))));
  app.post('/api/corrections/create', protectedRoute(async (req, res, actor) => res.json(await work(() => runCorrection('confirm', actor, req.body)))));
  app.post('/api/corrections/status', protectedRoute(async (req, res, actor) => res.json(await work(() => runCorrection('status', actor, req.body)))));
  for (const [name, route] of Object.entries(researchRoutes)) {
    app.post('/api/research/' + route, protectedRoute(async (req, res, actor) =>
      res.json(await work(() => runResearch(name as ResearchTool, actor, req.body)))));
  }
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
  app.get('/health', (_req, res) => res.json({ status: stopping ? 'stopping' : 'ok', version: '2.4.0', active_requests: active,
    access_mode: publicAccess.enabled ? 'public' : 'authenticated',
    active_authentications: authActive, active_dispatches: dispatchActive, release_commit: env.TAXLAB_RELEASE_COMMIT ?? null,
    research_harness: { policy: researchPolicyVersion, tools: researchTools.length, storage: 'ephemeral' },
    mcp_transport: { endpoint: '/mcp', mode: 'stateless', protocol: '2025-11-25', legacy_endpoint: '/sse',
      active: transportActive, max_transports: maxTransports, max_per_actor: maxTransportsPerActor, max_work: maxActive, budgets: budgets.limits },
    mcp_release: options.law.releaseVersion ?? null, taxlaw_release: options.law.taxlawRelease ?? null, rules_version: gates.version, maintenance: options.failures ? 'intake_only' : 'unavailable', correction_pr: options.corrections ? 'available' : 'unavailable' }));
  app.get('/api/tools', protectedRoute(async (_req, res) => res.json({ status: 'success', data: await work(() => options.law.listTools()) })));
  app.post('/api/validate', protectedRoute(async (req, res) => res.json(await work(async () => validate(req.body)))));
  app.post('/api/sources/check', protectedRoute(async (req,res,actor) => {
    res.json(await work(()=>checkSources(actor, req.body)));
  }));
  app.post('/api/analyze', protectedRoute(async (req, res, actor) => {
    const data = AnalyzeSchema.parse(req.body);
    return work(async () => {
      const quality = data.draft_answer ? validate({ draft_answer: data.draft_answer, query: data.query, facts: data.facts,
        skip_gates: data.skip_gates, mode: data.mode, force: data.force, bypass_reason: data.bypass_reason }) : null;
      if (quality?.blocked) return res.status(422).json({ code: 'DRAFT_CHECK_FAILED', quality_gate: quality });
      const args = { ...data.arguments };
      if (['legal_research', 'search_law', 'search_decisions', 'search_tax_interpretations', 'search_tax_decisions',
        'search_taxlaw', 'tax_research', 'search_local_tax_interpretations', 'search_local_tax_decisions'].includes(data.tool)) args.query = data.query;
      return res.json({ status: 'success', data: await retrieve(actor, data.tool, args, data.event_dates, data.query), quality_gate: quality });
    });
  }));
  app.post('/api/failures', protectedRoute(async (req, res, actor) => res.status(202).json(await work(() => submit(actor, req.body)))));
  app.get('/api/failures/:id', protectedRoute(async (req, res, actor) => {
    if (actor.kind === 'anonymous') throw new ServiceError(410, 'USE_CORRECTION_PR');
    const id = z.string().uuid().parse(req.params.id);
    if (!options.failures) throw new ServiceError(503, 'MAINTENANCE_UNAVAILABLE');
    res.json(await work(() => options.failures!.status(actor, id)));
  }));
  app.post('/api/evolve', protectedRoute(async () => { throw new ServiceError(410, 'USE_SUBMIT_FAILURE'); }));

  const custom: Tool[] = [
    ...researchTools,
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
  function mcpServer(actor: Actor, guard: RequestGuard = operation => operation()) {
    const mcpWork = <T>(operation: () => Promise<T>) => guard(() => work(operation));
    const server = new Server({ name: 'taxlab-legal-harness', version: '2.4.0' }, { capabilities: { tools: {} },
      instructions: researchInstructions + ' 법령 도구 결과는 조회 자료입니다. 사건 기준일·연혁·부칙·후속 해석을 확인하세요. 국세청 해석례는 search_tax_interpretations → get_tax_document로 사실관계·질의·회신을 읽고, 문서번호를 알면 lookup_tax_document를 쓰세요(도구가 제공되는 경우). 법제처 일련번호와 국세청 ntstDcmId를 혼용하지 마세요. 기존 validate_legal_draft는 별도의 제한된 초안 검사입니다. ' + correctionInstructions });
    const visible = actor.kind === 'anonymous' ? custom.filter(tool => tool.name !== 'submit_failure') : custom;
    server.setRequestHandler(ListToolsRequestSchema, () => mcpWork(async () => ({ tools: [...(await options.law.listTools()).tools.filter(t => !custom.some(c => c.name === t.name)).map(t => ({...t, description: (t.description ?? '') + '\n반박·새 근거로 기존 답변을 정정하면 prepare_correction_pr로 제안 내용을 준비하고 사용자에게 PR 생성을 물어보세요.'})), ...visible] })));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        return await mcpWork(async () => {
          const { name, arguments: args = {} } = request.params;
          if (Object.hasOwn(researchSchemas, name)) {
            const data = await runResearch(name as ResearchTool, actor, args);
            return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
          }
          if (['prepare_correction_pr', 'create_correction_pr', 'get_correction_pr', 'find_legal_corrections'].includes(name)) {
            const service = corrections();
            const data = name === 'prepare_correction_pr' ? await runCorrection('prepare', actor, args)
              : name === 'create_correction_pr' ? await runCorrection('confirm', actor, args)
              : name === 'get_correction_pr' ? await runCorrection('status', actor, args)
              : service.search(z.object({ query: z.string().min(1).max(20000) }).strict().parse(args).query);
            return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
          }
          if(name==='check_legal_sources') {
            const data=await checkSources(actor, args);
            return {content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data};
          }
          if (name === 'propose_tax_rule') throw new ServiceError(410, 'USE_SUBMIT_FAILURE');
          if (name === 'validate_tax_draft' || name === 'validate_legal_draft' || name === 'submit_failure') {
            const data = name === 'submit_failure' ? await submit(actor, args) : validate(args);
            return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
          }
          const data = await retrieve(actor, name, args);
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
    const release = admitTransport(actor);
    const transport = new SSEServerTransport('/messages', res);
    const server = mcpServer(actor);
    sessions.set(transport.sessionId, { actor, server, transport, touched: Date.now() });
    res.once('close', () => { release(); sessions.delete(transport.sessionId); void server.close(); });
    try { await server.connect(transport); } catch (error) { release(); sessions.delete(transport.sessionId); await server.close(); throw error; }
  }));
  app.post('/mcp', protectedRoute(async (req, res, actor) => {
    if (Array.isArray(req.body)) throw new ServiceError(400, 'BATCH_NOT_SUPPORTED');
    const release = admitTransport(actor);
    await serveStateless(req, res, guard => mcpServer(actor, guard), { ...budgets.limits, release });
  }));
  app.all('/mcp', protectedRoute(async (_req, res) => res.set('Allow', 'POST').status(405).json({ code: 'METHOD_NOT_ALLOWED' })));
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
  const drain = async (timeoutMs = 60_000) => {
    stopping = true;
    const until = performance.now() + timeoutMs;
    while (active || authActive || dispatchActive) {
      if (performance.now() >= until) throw new ServiceError(503, 'DRAIN_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { status: 'drained', active_requests: active, active_authentications: authActive, active_dispatches: dispatchActive };
  };
  return { app, drain, close: async () => { await drain(); clearInterval(timer); research.close(); await Promise.allSettled([...sessions.values()].map(s => s.server.close())); sessions.clear(); await Promise.allSettled([options.law.close(),options.sources?.close()]); } };
}
