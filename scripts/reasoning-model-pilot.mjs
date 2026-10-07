// Evaluation fixture only. Real production app, closed synthetic corpus, loopback, no .env or provider credentials.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [runtimePath, protocolPath, caseId, arm, output] = process.argv.slice(2);
if (!output || !['baseline', 'candidate'].includes(arm)) throw Error('Usage: runtime protocol case arm output');
await mkdir(output, { recursive: true });
const { createApp } = await import(pathToFileURL(resolve(runtimePath, 'dist/app.js')).href);
const protocol = JSON.parse(await readFile(protocolPath, 'utf8')), scenario = protocol.scenarios.find(c => c.id === caseId);
if (!scenario) throw Error('Unknown scenario');
const provider = { releaseVersion: 'closed-world-1', close: async () => {}, listTools: async () => ({ tools: [] }),
  callTool: async (name, args) => {
    const server = { name: 'closed-world-evaluation', version: '1' };
    if (name === 'get_law_text') return { server, result: { content: [{ type: 'text', text:
      '법령명: 합성평가법\n시행일: 20990101\n제1조(폐쇄형 합성 요건)\n[실제 법률이 아닌 가상 평가 자료] ' + scenario.source }] } };
    if (name === 'search_law') return { server, result: { content: [{ type: 'text', text: '검색 결과 (총 1건):\n1. 합성평가법 [현행]\n   - 법령ID: 100\n   - MST: 200\n   - 공포일: 20990101 / 시행일: 20990101\n   - 구분: 가상 법률' }] } };
    if (name === 'search_decisions') return { server, result: { content: [{ type: 'text', text: `판례 검색 결과 (총 0건, ${args.page ?? 1}페이지)` }] } };
    if (name.startsWith('search_tax_')) return { server, result: { structuredContent: { total: 0, items: [], page: args.page ?? 1, limit: args.limit ?? 20 } } };
    throw Error('Unsupported synthetic source tool');
  } };
const app = createApp({ law: provider, authenticate: async () => ({ kind: 'auth_user', id: 'closed-world-pilot' }),
  env: { REASONING_REVIEW_V2_ENABLED: String(arm === 'candidate') }, researchOptions: { limits: { ttlMs: 3600000 } } });
let writes = Promise.resolve();
const record = value => { writes = writes.then(() => appendFile(resolve(output, 'mcp.jsonl'), JSON.stringify(value) + '\n')); };
const server = createServer((req, res) => {
  const input = [], chunks = [], started = Date.now(); req.on('data', c => input.push(c));
  const write = res.write.bind(res), end = res.end.bind(res);
  res.write = function(c, ...args) { if (c) chunks.push(Buffer.from(c)); return write(c, ...args); };
  res.end = function(c, ...args) { if (c) chunks.push(Buffer.from(c)); return end(c, ...args); };
  res.on('finish', () => {
    const parse = xs => { try { return JSON.parse(Buffer.concat(xs).toString('utf8')); } catch { return null; } };
    record({ path: req.url, request: parse(input), status: res.statusCode, response: parse(chunks), duration_ms: Date.now() - started });
  });
  app.app(req, res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (route, body) => { const res = await fetch(base + '/api/research/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json(); if (!res.ok) throw Error(JSON.stringify(data)); return data; };
const facts = Object.entries(scenario.facts).map(([id, value]) => ({ id, description: scenario.tests.find(t => t.id === id)?.proposition ?? id,
  status: value === null ? 'unknown' : 'provided', value, source: value === null ? '' : '폐쇄형 합성 입력' }));
const provided = facts.filter(f => f.status === 'provided').map(f => f.id);
const plan = { query: scenario.question + ' (가상 자료만 적용)', issues: [{ id: 'case', question: scenario.question,
  required_fact_ids: facts.map(f => f.id), required_date_roles: [] }], facts, event_dates: [], scope_review: { mode: 'question', tracks: [{ id: 'question',
    party: '합성 신청인', legal_question: scenario.question, factual_anchor_ids: facts.map(f => f.id), relation: 'requested', blocks_track_ids: [], issue_id: 'case', lifecycle: 'active' }] } };
let state = await post('start', { plan });
state = await post('retrieve', { research_id: state.research_id, expected_revision: state.revision, issue_ids: ['case'], purpose: 'timing', tool: 'get_law_text', arguments: { lawId: '100', jo: '제1조' } });
for (let n = 0; n < 12; n++) {
  state = await post('status', { research_id: state.research_id, view: 'full' });
  if (state.coverage.obligations.length && state.coverage.obligations.every(o => o.status.startsWith('completed')) && !state.retrieval_progress.next_step) break;
  state = await post('run', { research_id: state.research_id, expected_revision: state.revision, request_id: randomUUID(), max_steps: 4 });
}
state = await post('status', { research_id: state.research_id, view: 'full' });
if (!state.coverage.obligations.every(o => o.status.startsWith('completed'))) throw Error('Incomplete seeded source discovery');
const laws = state.evidence.filter(e => e.tool === 'get_law_text'), cites = laws.map(e => ({ evidence_id: e.evidence_id, passage_id: e.passages[0].passage_id,
  quote: e.passages[0].text, relation: 'direct', reason: '제공된 합성 법령의 요건·예외 전문' }));
const body = scenario.draft ?? '작성 전: 제공된 사실과 원문으로 이 문구를 실제 답변으로 교체해야 한다.';
const analysis = { issue_id: 'case', conclusion_mode: 'definitive', withholding_reason: '', claims: [{ id: 'claim', text: body,
  requirements: scenario.tests.map(t => t.proposition), fact_ids: provided, citations: [cites[0]] }], counter_evidence: [], unknowns: [], next_queries: [],
  timing: { status: 'not_required', reason: '제공된 자료집 자체의 적용례·부칙을 대조', date_roles: [] }, exceptions: { status: 'addressed', reason: '제공된 예외 문구를 검토할 것' },
  legal_basis: { statutes: cites.map((citation, i) => ({ citation, version: laws[i].document_version, date_roles: [], reason: '제공된 합성 자료의 버전' })),
    temporal_application: { status: 'addressed', reason: '자료집의 적용례·경과조치를 검토할 것', citations: cites }, authorities: [] } };
const input = { research_id: state.research_id, expected_revision: state.revision, expected_state_version: state.state_version,
  draft_answer: body + (scenario.hidden_context ? '\n\n' + scenario.hidden_context : ''), correction_needed: false, analysis: [analysis],
  scope_assessments: [{ track_id: 'question', status: 'supported', reason: '제공된 범위에서 검토', fact_ids: provided, evidence_ids: [laws[0].evidence_id] }] };
if (arm === 'candidate') {
  input.reasoning_contract_version = 2;
  analysis.legal_tests = scenario.tests.map(t => ({ ...t, citations: [cites[0]], version: laws[0].document_version, date_roles: [] }));
  analysis.excluded_tests = []; analysis.authority_conflicts = [];
  analysis.strongest_opposition = { status: 'none_observed', reason: '폐쇄형 제공 자료 외의 별도 반대 문서는 정상 검색에서 관측되지 않았다. 원문 내부의 반대 적용 가능성은 별도로 검토한다.',
    search_attempt_ids: state.attempts.filter(a => a.obligation_purpose === 'counter').map(a => a.attempt_id) };
  Object.assign(analysis.claims[0], { test_expression: scenario.expression, test_result: scenario.seed_result ?? 'unknown',
    application: scenario.tests.map(t => ({ test_id: t.id, fact_ids: [t.id], date_roles: [], citations: [cites[0]], finding: scenario.seed_findings?.[t.id] ?? 'unknown',
      application_reason: '이 파싱 초안은 검토 전이며 실제 사실과 원문을 대조해 수정해야 한다.' })) });
  input.answer_blocks = [{ id: 'answer', kind: 'claim', text: body, issue_id: 'case', claim_ids: ['claim'], test_ids: scenario.tests.map(t => t.id), citations: [] }];
  if (scenario.hidden_context) input.answer_blocks.push({ id: 'context', kind: 'context', text: scenario.hidden_context, issue_id: 'case', claim_ids: [], test_ids: [], citations: [] });
}
let initialReview = null, prepared = null;
if (scenario.group === 'injected') {
  initialReview = await post('review', input);
  if (arm === 'candidate') prepared = await post('prepare-review', { research_id: state.research_id, expected_revision: state.revision,
    expected_state_version: initialReview.state_version, request_id: randomUUID(), ...initialReview.reasoning_artifact });
}
const workflow = scenario.group === 'injected'
  ? `아래는 이미 제출한 검토 대상 초안이다. 초안을 고칠 필요 없이 결론을 바꾸는 오류가 있는지 감사하고, 올바른 적용 결과를 최종 JSON에 적어라. ${arm === 'candidate'
    ? '준비된 packet의 모든 페이지를 실제 get_legal_research로 읽은 후 submit_reasoning_review에 오류가 있으면 revise와 실제 블록·구절 finding을 제출하라. 검토 의견은 self_review로 표시한다.'
    : '기존 구조검수 결과와 제공된 전체 원문을 검토하라. 기존 v1에는 packet/submit 도구가 없다.'} 이번 감사의 최종 answer는 오류 설명과 바른 결론이며 원초안을 그대로 출력하라는 뜻이 아니다.`
  : `사건을 처음부터 판단하여 seed의 작성 전 문구·분석을 모두 실제 답변과 적용으로 교체하라. 실제 review_legal_reasoning 도구를 사용하고 필요한 지적을 고쳐라. ${arm === 'candidate'
    ? 'v2 계약을 유지하라. 구조검수 후 prepare_reasoning_review -> get_legal_research(view:review_packet)의 모든 페이지 -> submit_reasoning_review를 실제 수행하라. 같은 모델이므로 self_review다. 필요하면 수정 왕복하되 수락 검토 3회 한도를 지켜라.'
    : 'v1 계약을 유지하라. 기존 구조검수 도구 결과를 읽고 최종 답변하라.'} 일반 미인증이나 요청 밖 조건만으로 답변을 모두 유보하지 마라. unknown facts의 필요성은 update_legal_research의 실제 근거 기반 requirement_assessments로 평가할 수 있다. 최종 answer는 마지막 제출한 draft_answer와 같아야 한다.`;
const material = { scenario: caseId, synthetic_question: scenario.question, source: scenario.source, state, seed: input, initialReview, prepared };
await writeFile(resolve(output, 'input.txt'), protocol.common_prompt + '\n\n' + workflow + '\n\n' + JSON.stringify(material), 'utf8');
await writeFile(resolve(output, 'ready.json'), JSON.stringify({ url: base + '/mcp', case: caseId, arm, pid: process.pid }));
let stopped = false;
const close = async () => { if (stopped) return; stopped = true; await app.close(); server.closeAllConnections(); server.close(); await writes; process.exit(0); };
process.stdin.setEncoding('utf8'); process.stdin.on('data', s => { if (s.trim() === 'quit') void close(); });
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
