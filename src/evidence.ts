import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { digest } from './contracts.js';

/** UI navigation is separate from provider text and from a verified applicability claim. */
export function rawStatuteNavigation(tool: string, args: Record<string, unknown>, result: CallToolResult) {
  // efYd can redirect the upstream to a different historical MST. A lawId is a
  // lineage identifier, not a version identifier, so neither is guessed here.
  if (tool !== 'get_law_text' || result.isError || args.efYd !== undefined
    || typeof args.mst !== 'string' || !/^[1-9]\d{0,11}$/.test(args.mst)) return undefined;
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const name = /^법령명:[ \t]*(\S[^\r\n]*)/m.exec(text)?.[1]?.trim();
  const effective = /^시행일:[ \t]*(\d{8})[ \t]*\r?$/m.exec(text)?.[1];
  if (!name || name.length > 200 || !effective) return undefined;
  return { purpose: 'navigation_only', url: 'https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=' + args.mst,
    link_basis: 'requested_mst', observed_effective_date: effective,
    note: '요청한 법령일련번호의 공식 탐색 링크입니다. 별도 웹페이지를 조회한 증거가 아니며 최신성·사건 적용 검증을 뜻하지 않습니다. 단순 원문·시행일·링크 요청은 원문 도구 결과로 답하고 사건 연구를 시작하지 마세요.' };
}

/** Retrieval provenance is distinct from a claim of currency/applicability. */
export function retrievalEnvelope(tool: string, args: Record<string, unknown>, result: CallToolResult, upstream: string, eventDates: Record<string, string> = {}) {
  return { schema_version: 1, purpose: 'retrieval_only', tool, arguments_hash: digest(args),
    observed_at: new Date().toISOString(), content_hash: digest(result), upstream_version: upstream,
    event_dates: eventDates, source_access: result.isError ? 'unavailable' : 'available',
    version_selection: 'unresolved', applicability: 'unverified', transitional_provisions: 'unverified', subsequent_interpretations: 'unverified',
    note: '조회 성공·조회 시각·패키지 버전은 법령 최신성이나 사건 적용 확인을 뜻하지 않습니다. 공식 원문·연혁·부칙을 대조하세요.' };
}
