import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { usageFailureCode } from './usageFailures.js';

export const OUTCOME_META = 'legal-harness/retrieval-outcome';
export const OUTCOME_VERSION = 'retrieval-outcome-v1';
export const NTS_LIST_DEFAULT_LIMIT = 10;
const trustedMetadata = new WeakMap<object, Record<string, unknown>>();
/** Only metadata created at our retrieval boundary may cross error sanitization. */
export const retrievalOutcomeMetadata = (result: object) => trustedMetadata.get(result) ?? {};
export function preserveOutcomeMetadata<T extends object>(diagnostic: T, original: object): T {
  const metadata = trustedMetadata.get(original);
  return metadata ? { ...diagnostic, _meta: metadata } : diagnostic;
}
export const outcomes = ['found', 'empty_confirmed', 'page_out_of_range', 'document_unresolved',
  'body_unavailable', 'partial', 'failed', 'unclassified'] as const;
export type RetrievalOutcome = typeof outcomes[number];
export type RetrievalOperation = 'list_search' | 'exact_lookup' | 'body_read' | 'compound';
export interface ProviderIdentity { name: 'nts' | 'law' | 'attachment'; version?: string; commit?: string }
const contracts = JSON.parse(readFileSync(new URL('../upstreams/search-outcome-contracts.json', import.meta.url), 'utf8')) as {
  nts: { version: string; commit: string; contract: string; schema: string };
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export const outcomeEnabled = (env: NodeJS.ProcessEnv) => env.TAXLAB_SEARCH_OUTCOME_V1 === 'true';
export const supportsNtsProof = (provider: { version?: string; commit?: string }) =>
  provider.version === contracts.nts.version && provider.commit === contracts.nts.commit;

const lists = new Set(['search_decisions', 'search_law', 'search_tax_interpretations', 'search_tax_decisions',
  'search_local_tax_interpretations', 'search_local_tax_decisions', 'search_tax_guidance', 'search_tax_forms']);
const reads = new Set(['get_decision_text', 'get_law_text', 'get_tax_document', 'get_tax_guidance', 'read_tax_attachment']);
const lookups = new Set(['lookup_tax_document', 'lookup_local_tax_document']);
export const outcomeTools = new Set([...lists, ...reads, ...lookups, 'search_taxlaw', 'execute_tool', 'legal_research']);
export function retrievalOperation(name: string, args: Record<string, unknown>): RetrievalOperation | undefined {
  if (lookups.has(name)) return 'exact_lookup';
  if (reads.has(name)) return 'body_read';
  if (['search_taxlaw', 'execute_tool', 'legal_research'].includes(name)) return 'compound';
  if (!lists.has(name)) return undefined;
  if (['document_number', 'case_number'].some(key => typeof args[key] === 'string' && args[key].trim())) return 'exact_lookup';
  if (name === 'search_decisions' && object(args.options).includeText) return 'compound';
  if (name === 'search_decisions' && object(args.options).caseNumber) return 'exact_lookup';
  return 'list_search';
}
/** The opt-in proof contract covers only these ordinary NTS list arguments. */
export function ordinaryNtsList(name: string, args: Record<string, unknown>): boolean {
  const allowed = new Set(['query', 'type', 'law', 'article', 'match', 'exclude', 'tax_type', 'date_from', 'date_to', 'sort', 'page', 'limit',
    ...(name === 'search_tax_interpretations' ? ['document_number'] : ['case_number', 'result', 'attribution_year', 'attachment_status'])]);
  return retrievalOperation(name, args) === 'list_search' && Object.keys(args).every(key => allowed.has(key))
    && ((name === 'search_tax_interpretations' && ['all', 'advance', 'written', 'advisory', 'notice_written'].includes(String(args.type ?? 'all')))
      || (name === 'search_tax_decisions' && ['all', 'pre_assessment', 'objection', 'review', 'tribunal', 'court', 'constitutional'].includes(String(args.type ?? 'all'))));
}
export interface OutcomeEvent {
  tool: string; operation: RetrievalOperation; outcome: RetrievalOutcome;
  provider: ProviderIdentity['name']; provider_version: string; code: string;
}
export interface OutcomeDecision { event?: OutcomeEvent; result?: CallToolResult; recovered: boolean }

/** Bounded, synchronous classification of an already obtained response. No I/O or retries. */
export function classifyRetrieval(name: string, args: Record<string, unknown>, provider: ProviderIdentity,
  result?: CallToolResult, error?: unknown): OutcomeDecision {
  const operation = retrievalOperation(name, args);
  if (!operation) return { result, recovered: false };
  const data = object(result?.structuredContent), failed = error !== undefined || result?.isError === true;
  const code = failed ? usageFailureCode(error ?? result, error !== undefined) : 'NONE';
  let outcome: RetrievalOutcome = 'unclassified', recovered = false;
  if (code === 'DETAIL_NOT_AVAILABLE') outcome = 'body_unavailable';
  else if (['NOT_FOUND', 'LAW_NOT_FOUND'].includes(code) && ['exact_lookup', 'body_read'].includes(operation)) outcome = 'document_unresolved';
  else if (code === 'LOOKUP_INCOMPLETE') outcome = 'partial';
  else if (failed && !['NOT_FOUND', 'LAW_NOT_FOUND', 'MCP_TOOL_ERROR', 'UNCLASSIFIED_ERROR', 'UNCLASSIFIED_EXCEPTION'].includes(code)) outcome = 'failed';
  const documentScope = object(object(result?._meta)['legal-harness/taxlaw']).body_scope;
  if (!failed && ['exact_lookup', 'body_read'].includes(operation)) {
    if (documentScope === 'provided') outcome = 'found';
    if (documentScope === 'partial' || documentScope === 'unavailable') outcome = 'partial';
  }
  const ordinary = ordinaryNtsList(name, args) && provider.name === 'nts' && supportsNtsProof(provider);
  const proof = object(failed ? object(object(data.error).detail).searchProof : data.searchProof);
  // Match the pinned public tools' default without changing transmitted arguments.
  const page = args.page ?? 1, limit = args.limit ?? NTS_LIST_DEFAULT_LIMIT;
  const valid = ordinary && proof.contract === contracts.nts.contract && proof.schema === contracts.nts.schema
    && proof.operation === 'list_search' && Number.isSafeInteger(page) && Number(page) > 0
    && Number.isSafeInteger(limit) && Number(limit) > 0 && Number(limit) <= 100
    && proof.page === page && proof.limit === limit && Number.isSafeInteger(proof.total) && Number(proof.total) >= 0
    && Number.isSafeInteger(proof.returned) && Number(proof.returned) >= 0 && Number(proof.returned) <= Number(limit)
    && typeof proof.scope_verified === 'boolean';
  if (valid && (!failed || (code === 'NOT_FOUND' && data.ok === false && object(data.error).code === 'NOT_FOUND'))) {
    const total = Number(proof.total), returned = Number(proof.returned), expected = Math.min(Number(limit), Math.max(0, total - (Number(page) - 1) * Number(limit)));
    if (proof.status === 'partial' || proof.scope_verified === false) outcome = 'partial';
    else if (proof.scope_verified === true && !data.unresolvedTaxTypes) {
      if (failed && returned === 0 && total === 0 && page === 1 && proof.status === 'empty_confirmed') outcome = 'empty_confirmed';
      else if (failed && returned === 0 && total > 0 && (Number(page) - 1) * Number(limit) >= total
        && proof.status === 'page_out_of_range') outcome = 'page_out_of_range';
      else if (!failed && returned > 0 && returned === expected && proof.status === 'found' && data.total === total
        && data.page === page && data.limit === limit && Array.isArray(data.items) && data.items.length === returned) outcome = 'found';
    }
    if (outcome === 'empty_confirmed' || outcome === 'page_out_of_range') {
      const payload = { domain: name === 'search_tax_interpretations' ? 'interpretation' : 'decision', total, page, limit, items: [],
        message: outcome === 'empty_confirmed' ? '이 검색 조건과 국세청 자료원에서 검색 결과가 0건입니다.' : '요청한 페이지가 마지막 결과 페이지 이후입니다.',
        guardrail: '이 결과는 해당 검색 범위의 목록 조회 결과입니다. 다른 자료원의 부존재, 앞 페이지 확인, 연구 완료 또는 법률 결론의 확정을 뜻하지 않습니다.' };
      result = { isError: false, structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) }] };
      recovered = true;
    }
  }
  const event: OutcomeEvent = { tool: name, operation, outcome, provider: provider.name,
    provider_version: provider.name === 'nts' && supportsNtsProof(provider) ? contracts.nts.version : 'unsupported', code };
  if (result) {
    const metadata = { [OUTCOME_META]: { version: OUTCOME_VERSION, operation, status: outcome } };
    result = { ...result, _meta: { ...result._meta, ...metadata } };
    trustedMetadata.set(result, metadata);
  }
  return { event, result, recovered };
}
