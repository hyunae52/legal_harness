import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { digest } from './contracts.js';

/** Retrieval provenance is distinct from a claim of currency/applicability. */
export function retrievalEnvelope(tool: string, args: Record<string, unknown>, result: CallToolResult, upstream: string, eventDates: Record<string, string> = {}) {
  return { schema_version: 1, purpose: 'retrieval_only', tool, arguments_hash: digest(args),
    observed_at: new Date().toISOString(), content_hash: digest(result), upstream_version: upstream,
    event_dates: eventDates, source_access: result.isError ? 'unavailable' : 'available',
    version_selection: 'unresolved', applicability: 'unverified', transitional_provisions: 'unverified', subsequent_interpretations: 'unverified',
    note: '조회 성공·조회 시각·패키지 버전은 법령 최신성이나 사건 적용 확인을 뜻하지 않습니다. 공식 원문·연혁·부칙을 대조하세요.' };
}
