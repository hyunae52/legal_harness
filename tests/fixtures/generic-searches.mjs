import { randomUUID } from 'node:crypto';
import { digest } from '../../dist/contracts.js';
import { observeSearch } from '../../dist/researchSearch.js';

// Synthetic non-tax sources. These fixed provider replies are independent of coverage calculation.
export const emptyCourtResult = () => ({ result: { content: [{ type: 'text', text: '판례 검색 결과 (총 0건, 1페이지)' }] } });
export const emptyLawResult = () => ({ result: { content: [{ type: 'text', text: '검색 결과 (총 0건):' }] } });
export function genericSearchAttempts(numbers = [], issue = 'cost') {
  const requests = [
    ['합성법 제1조', 'context'], ['합성법 제1조 요건', 'context'],
    ['합성법 제1조 적용 제외', 'counter'], ['합성법 제1조 예외', 'counter'],
    ...numbers.flatMap(number => [[number + ' 변경', 'context'], [number, 'context']]),
  ].map(([query, purpose]) => ({ tool: 'search_decisions', purpose,
    args: { domain: 'precedent', query, page: 1, display: 20, sort: 'ddes', options: { search: 2 } }, response: emptyCourtResult() }));
  requests.push({ tool: 'search_law', purpose: 'timing', args: { query: '합성법', display: 50 }, response: emptyLawResult() });
  return requests.map(({ tool, purpose, args, response }) => ({ attempt_id: randomUUID(), revision: 1,
    issue_ids: [issue], purpose, tool, arguments_hash: digest(args), status: 'empty', search: observeSearch(tool, args, response) }));
}
