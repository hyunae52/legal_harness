import { randomUUID } from 'node:crypto';
import { ResearchService } from '../../dist/research.js';

export const coverageActor = { kind: 'auth_user', id: 'authority-fixture' };
export const coveragePlan = () => ({ query: '합성 소득세법 취득 요건',
  issues: [{ id: 'case', question: '합성 취득 요건', required_fact_ids: ['known'], required_date_roles: [] }],
  facts: [{ id: 'known', description: '합성 취득 사실', status: 'provided', value: '충족', source: '합성 입력' }], event_dates: [],
  scope_review: { mode: 'question', tracks: [{ id: 'question', party: '납세자', legal_question: '취득 요건', factual_anchor_ids: ['known'], relation: 'requested', blocks_track_ids: [], issue_id: 'case', lifecycle: 'active' }] } });
export function providerResponse(name, args, overrides = {}) {
  const server = { name: name.startsWith('search_tax_') || name === 'get_tax_document' ? 'korean-taxlaw' : 'korean-law-mcp', version: 'fixture' };
  if (name === 'get_law_text') return { server, result: { content: [{ type: 'text', text: '법령명: 소득세법\n시행일: 20200101\n제1조(합성 요건)\n합성 취득 요건을 충족하면 적용한다. 부칙: 2020년부터 적용한다.' }] } };
  if (name === 'search_law') return { server, result: { content: [{ type: 'text', text: '검색 결과 (총 1건):\n\n1. 소득세법 [현행]\n   - 법령ID: 100\n   - MST: 200\n   - 공포일: 20200101 / 시행일: 20200101\n   - 구분: 법률\n' }] } };
  if (name === 'search_decisions') return { server, result: { content: [{ type: 'text', text: `판례 검색 결과 (총 0건, ${args.page ?? 1}페이지)` }] } };
  if (name.startsWith('search_tax_')) return { server, result: { structuredContent: { total: 0, items: [], page: args.page ?? 1, limit: args.limit ?? 20, ...overrides } } };
  throw new Error('Unexpected fixture request: ' + name);
}
export function coverageFixture(operation, options = {}) {
  const calls = [], provider = { callTool: async (name, args) => { calls.push({ name, args }); return operation ? operation(name, args) : providerResponse(name, args); } };
  const service = new ResearchService(provider, undefined, options);
  const api = async (name, s, args = {}) => service.run(name, coverageActor, { research_id: s.research_id, expected_revision: s.revision, ...args });
  const start = async (plan = coveragePlan()) => service.run('start_legal_research', coverageActor, { plan });
  const law = async s => api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'timing', tool: 'get_law_text', arguments: { lawId: '100', jo: '제1조' } });
  const run = async (s, args = {}) => api('run_required_legal_research', s, { request_id: randomUUID(), max_steps: 4, ...args });
  const finish = async s => {
    for (let n = 0; n < 12; n++) {
      if (s.coverage.obligations.length && s.coverage.obligations.every(o => o.status.startsWith('completed')) && !s.pending
        && s.coverage.candidates.every(c => c.discovery_role === 'exploratory' || s.evidence.some(e => e.revision === s.revision && e.body_scope === 'body_returned'
          && e.identity && (`${e.identity.namespace}:${e.identity.family}:${e.identity.document_id}` === c.key
            || (c.statute && e.document_id === c.statute.mst && e.statute_anchor?.name === c.statute.name))))) return s;
      s = await run(s);
      if (s.job?.status === 'failed') return s;
    }
    throw new Error('Fixture did not finish within its budget');
  };
  return { service, calls, api, start, law, run, finish };
}
export function coverageReview(s) {
  const law = s.evidence.findLast(e => e.revision === s.revision && e.tool === 'get_law_text');
  const citation = { evidence_id: law.evidence_id, passage_id: law.passages[0].passage_id, quote: law.passages[0].text, relation: 'direct', reason: '합성 요건의 직접 원문' };
  const laws = s.evidence.filter(e => e.revision === s.revision && e.tool === 'get_law_text' && e.body_scope === 'body_returned');
  const lawCitations = laws.map(e => ({ ...citation, evidence_id: e.evidence_id, passage_id: e.passages[0].passage_id, quote: e.passages[0].text }));
  return { research_id: s.research_id, expected_revision: s.revision, expected_state_version: s.state_version,
    draft_answer: '합성 법령의 요건을 적용한다.', correction_needed: false, analysis: [{ issue_id: 'case', conclusion_mode: 'definitive', withholding_reason: '',
      claims: [{ id: 'claim', text: '합성 법령의 요건을 적용한다.', requirements: ['취득 요건'], fact_ids: ['known'], citations: [citation] }],
      counter_evidence: [], unknowns: [], next_queries: [], timing: { status: 'not_required', reason: '합성 사례', date_roles: [] },
      exceptions: { status: 'addressed', reason: '합성 예외 검토' }, legal_basis: {
        statutes: lawCitations.map((citation, i) => ({ citation, version: laws[i].document_version, date_roles: [], reason: '합성 적용 법령과 검색한 MST 대조' })),
        temporal_application: { status: 'addressed', reason: '부칙 확인', citations: lawCitations }, authorities: [],
      } }], scope_assessments: [{ track_id: 'question', status: 'supported', reason: '필요한 범위 수행', fact_ids: ['known'], evidence_ids: [law.evidence_id] }] };
}
