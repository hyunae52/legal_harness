import { digest } from './contracts.js';
import { object, short, contents, identityFromDocument, documentKey, type SourceIdentity } from './researchIdentity.js';

export type SearchFamily = 'court' | 'administrative' | 'adjudication' | 'statute';
export interface SearchHit { key: string; identity: SourceIdentity; title: string; related_laws: string; source_url: string | null;
  statute?: { law_id: string; mst: string; name: string; effective_date: string | null } }
export interface SearchObservation {
  family: SearchFamily | 'unknown'; namespace: string; query: string; filters: Record<string, unknown>;
  signature: string; status: 'complete' | 'partial' | 'failed'; error_code?: string;
  page: number; page_size: number; total: number | null; has_more: boolean | null; hits: SearchHit[];
  retry_after_ms?: number;
  indexed_scope: string; provider_internal_calls: 'unobserved';
}
export function searchFamily(tool: string, args: Record<string, unknown>): SearchFamily | 'unknown' {
  if (tool === 'search_law') return 'statute';
  if (tool === 'search_decisions') return args.domain === 'precedent' ? 'court' : args.domain === 'tax_tribunal' ? 'adjudication' : 'unknown';
  if (tool === 'search_tax_decisions') return args.type === 'court' ? 'court' : ['review', 'tribunal'].includes(String(args.type)) ? 'adjudication' : 'unknown';
  if (tool === 'search_tax_interpretations' || tool === 'search_local_tax_interpretations') return 'administrative';
  return 'unknown';
}
export const normalizeQuery = (v: unknown) => typeof v === 'string' ? v.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
export function normalizedSearch(tool: string, args: Record<string, unknown>) {
  const keys = ['domain', 'type', 'law', 'article', 'match', 'exclude', 'tax_type', 'date_from', 'date_to', 'sort', 'options'];
  const filters = Object.fromEntries(keys.filter(k => args[k] !== undefined && args[k] !== null).map(k => [k, args[k]]));
  const query = normalizeQuery(args.query), page = Number(args.page ?? 1), pageSize = Number(args.limit ?? args.display ?? 20);
  return { query, filters, page, page_size: pageSize, signature: digest({ tool, query, filters, page, pageSize }) };
}
export function observeSearch(tool: string, args: Record<string, unknown>, response: unknown): SearchObservation {
  const wrapper = object(response), result = object(wrapper.result), data = object(result.structuredContent);
  const tax = tool.startsWith('search_tax_'), local = tool.startsWith('search_local_tax_');
  const obs: SearchObservation = { ...normalizedSearch(tool, args), family: searchFamily(tool, args), namespace: tax ? 'nts' : local ? 'olta' : 'moleg',
    status: 'partial', error_code: 'SEARCH_SCOPE_UNOBSERVED', total: null, has_more: null, hits: [],
    indexed_scope: tax ? '국세법령정보시스템 수록 자료; 전체 법원 판결 수록 보증 아님' : local ? '지방세법령정보시스템 수록 자료' : '국가법령정보센터 수록 자료', provider_internal_calls: 'unobserved' };
  const fail = (code: string) => { obs.status = 'failed'; obs.error_code = code; return obs; };
  const supported = tax ? new Set(['query', 'type', 'law', 'article', 'page', 'limit', 'sort', 'match'])
    : local ? new Set(['query', 'type', 'page', 'limit']) : new Set(['domain', 'query', 'page', 'display', 'sort', 'options']);
  if (Object.keys(args).some(k => !supported.has(k)) || obs.family === 'unknown' || !obs.query || !Number.isSafeInteger(obs.page) || obs.page < 1
    || !Number.isSafeInteger(obs.page_size) || obs.page_size < 1 || obs.page_size > 100) return obs;
  if (args.match && args.match !== 'all') return obs;
  if (!tax && !local && Object.keys(object(args.options)).some(k => !['court', 'search'].includes(k))) return obs;
  if ((tax || local) && data.unresolvedTaxTypes) return obs;
  if (result.isError === true) {
    // Pinned NTS tools use NOT_FOUND only after a successfully parsed search; never apply to lookup/compound tools.
    const error = object(data.error);
    if (tax && error.code === 'NOT_FOUND' && data.ok === false && obs.page === 1) {
      obs.total = 0; obs.has_more = false; obs.status = 'complete'; delete obs.error_code; return obs;
    }
    if (error.code === 'RATE_LIMITED') {
      const seconds = Number(object(error.detail).retryAfterSec);
      if (Number.isFinite(seconds) && seconds > 0) obs.retry_after_ms = Math.min(60000, Math.ceil(seconds * 1000));
      return fail('SEARCH_RATE_LIMITED');
    }
    return fail('SEARCH_PROVIDER_ERROR');
  }
  if (tax || local) {
    if (!Number.isSafeInteger(data.total) || Number(data.total) < 0 || !Array.isArray(data.items)
      || data.page !== obs.page || data.limit !== obs.page_size) return obs;
    obs.total = Number(data.total);
    for (const raw of data.items) {
      const doc = object(raw), identity = identityFromDocument(doc, obs.namespace, local ? 'local_tax' : 'tax_document');
      if (local && identity.document_id === 'unknown') identity.document_id = identity.document_number ?? 'unknown';
      const key = documentKey(identity);
      obs.hits.push({ key: key ?? 'unknown:' + digest(doc), identity, title: short(doc.title, 1000) ?? '',
        related_laws: short(doc.relatedLawsText ?? doc.relatedLaws, 3000) ?? '', source_url: short(doc.sourceUrl, 1024) });
    }
  } else if (tool === 'search_law') {
    const text = contents(result), header = /^검색 결과 \(총 (\d+)건\)/m.exec(text);
    if (!header || /확장쿼리|응답 크기 제한|잘렸|시행예정.*실패/.test(text)) return obs;
    obs.total = Number(header[1]);
    for (const m of text.matchAll(/^\d+\. ([^\r\n]+)\r?\n\s*- 법령ID: ([^\r\n]+)\r?\n\s*- MST: ([^\r\n]+)(?:\r?\n\s*- 공포일: [^\r\n]*?시행일: (\d{8}))?/gm)) {
      const identity = identityFromDocument({ id: m[2] + '/' + m[3] }, 'moleg', 'statute');
      identity.kind = 'other'; identity.status = 'observed';
      obs.hits.push({ key: documentKey(identity)!, identity, title: m[1].slice(0, 1000), related_laws: '', source_url: null,
        statute: { law_id: m[2].trim(), mst: m[3].trim(), name: m[1].replace(/\s*\[[^\]]*\]\s*$/, '').trim(), effective_date: m[4] ?? null } });
    }
  } else if (tool === 'search_decisions' && args.domain === 'precedent') {
    const text = contents(result), header = /^판례 검색 결과 \(총 (\d+)건, (\d+)페이지\)/m.exec(text);
    // Automatic upstream fallback may alter query, scope or date filtering. Such summaries are not completion evidence.
    if (!header || Number(header[2]) !== obs.page || /검색 보정|응답 크기 제한|(?:본문|결과)[^\n]*축약|잘렸/.test(text)) return obs;
    obs.total = Number(header[1]);
    const rows = [...text.matchAll(/^\[([^\]\r\n]+)\] ([^\r\n]+)\r?\n\s*사건번호: ([^\r\n]+)\r?\n\s*법원: ([^\r\n]+)\r?\n\s*선고일: ([^\r\n]+)/gm)];
    for (const row of rows) {
      const identity = identityFromDocument({ id: row[1], caseNumber: row[3], court: row[4], decisionDate: row[5] }, 'moleg', 'precedent');
      obs.hits.push({ key: documentKey(identity)!, identity, title: row[2].slice(0, 1000), related_laws: '', source_url: null });
    }
    if (object(args.options).court && obs.hits.some(h => h.identity.agency !== object(args.options).court)) return obs;
  } else return obs;
  const expected = Math.min(obs.page_size, Math.max(0, obs.total! - (obs.page - 1) * obs.page_size));
  if (obs.hits.length !== expected || new Set(obs.hits.map(h => h.key)).size !== obs.hits.length) return obs;
  obs.has_more = obs.page * obs.page_size < obs.total!;
  obs.status = 'complete'; delete obs.error_code;
  return obs;
}
