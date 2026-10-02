import { ServiceError } from './contracts.js';
import type { ResearchTool } from './researchContracts.js';
import type { ResearchEvidence } from './researchEvidence.js';
import { storedBytes } from './researchStorage.js';
import { answerWritingGuide, researchReadingGuide } from './evidence.js';
import { reviewRecoveryGuide } from './inputDiagnostics.js';

type RecordValue = Record<string, any>;
export const researchResponseContract = 'research-response-v3-fidelity-20261002';
const sizeLimit = 30_000; // Leave room for the authoritative public continuation handle and JSON envelope.
const pick = (value: RecordValue, names: string[]) => Object.fromEntries(names.filter(k => k in value).map(k => [k, value[k]]));
const identityFields = ['status', 'research_id', 'revision', 'state_version', 'expires_at', 'policy_version', 'pending', 'remaining_attempts', 'last_review', 'legal_verification'];
function collections(state: RecordValue): Record<string, any[]> {
  return { attempts: state.attempts ?? [], obligations: state.coverage?.obligations ?? [], candidates: state.coverage?.candidates ?? [],
    worklist: state.review_worklist ?? [], manifests: state.manifests ?? [], jobs: state.jobs ?? [], requirements: state.requirements ?? [], requirement_history: state.requirement_history ?? [],
    evidence_index: (state.evidence_index ?? state.evidence ?? []).map((e: ResearchEvidence) => pick(e,
      ['evidence_id', 'manifest_id', 'document_id', 'document_version', 'revision', 'source_revision', 'issue_ids', 'body_scope', 'identity', 'observed_at'])) };
}

/** Public presentation only: the deterministic reviewer still consumes the entire server state. */
export function presentResearch(name: ResearchTool, raw: unknown, state: RecordValue): RecordValue {
  const input = raw as RecordValue;
  if (name === 'review_legal_reasoning') return { ...state, response_mode: 'review', response_contract: researchResponseContract,
    answer_writing_guide: answerWritingGuide, review_recovery: { ...reviewRecoveryGuide, review_performed: true, review_status: state.status } };
  const head = { ...pick(state, identityFields), response_contract: researchResponseContract };
  const lists = collections(state);
  if (name === 'get_legal_research' && input.evidence_ids) return { ...head, response_mode: 'selected_evidence',
    evidence: state.evidence, evidence_selection: state.evidence_selection,
    source_reading_guide: researchReadingGuide(state.evidence),
    evidence_index: lists.evidence_index,
    manifests: (state.manifests ?? []).filter((m: RecordValue) => m.evidence_ids.some((id: string) => input.evidence_ids.includes(id))),
    note: '선택한 원문만 반환합니다. 본문은 저장한 바이트 그대로이며 다른 원문은 evidence_index 페이지에서 확인하세요.' };
  if (name === 'get_legal_research' && input.view === 'full') return { ...state,
    response_mode: 'explicit_full', response_contract: researchResponseContract,
    note: '명시적으로 요청한 전체 상태입니다. 일반 진행 응답은 요약이며 원문 읽기는 evidence_ids를 권장합니다.' };
  if (name === 'get_legal_research' && input.view === 'plan') return { ...head, response_mode: 'explicit_plan', plan: state.plan };
  if (name === 'get_legal_research' && input.view && input.view !== 'summary') {
    const all = lists[input.view];
    if (!all) throw new ServiceError(400, 'RESEARCH_VIEW_INVALID');
    const cursor = input.cursor;
    if (cursor && (cursor.research_id !== state.research_id || cursor.revision !== state.revision
      || cursor.state_version !== state.state_version || cursor.view !== input.view)) throw new ServiceError(409, 'RESEARCH_STATE_CHANGED');
    const start = cursor?.offset ?? 0, limit = input.limit ?? 10;
    if (start > all.length) throw new ServiceError(400, 'RESEARCH_CURSOR_INVALID');
    const items: unknown[] = [];
    for (const item of all.slice(start, start + limit)) {
      // Pages carry complete items. No truncation of a required candidate, receipt, or fact.
      if (items.length && storedBytes([...items, item]) > 65_536) break;
      items.push(item);
    }
    const end = start + items.length, hasMore = end < all.length;
    return { ...head, response_mode: 'page', collection: input.view, items,
      page: { total: all.length, offset: start, has_more: hasMore, next_cursor: hasMore ? { research_id: state.research_id,
        revision: state.revision, state_version: state.state_version, view: input.view, offset: end } : null } };
  }
  const progress = state.retrieval_progress ?? {}, interview = state.interview ?? {};
  const available = state.recovery?.available_actions ?? [];
  const out: RecordValue = { ...head, response_mode: 'summary', recovery: state.recovery,
    ...(state.job ? { job: state.job } : {}), ...(state.replayed ? { replayed: true } : {}),
    retrieval_progress: { ...pick(progress, ['state', 'pending_search_count', 'source_gap_count']),
      missing_body_candidate_count: progress.missing_body_candidate_ids?.length ?? 0,
      next_step: available.includes('retrieve') ? progress.next_step : null,
      retrieval_allowed: available.includes('retrieve') },
    interview: { ...pick(interview, ['next_action', 'next_question', 'unresolved_count', 'assessment_pending_count', 'coverage', 'fact_verification', 'legal_verification']),
      details_view: 'requirements' },
    collections: Object.fromEntries(Object.entries(lists).map(([view, items]) => [view, { total: items.length,
      read: { research_id: state.research_id, view, limit: 10 } }])),
    plan_read: { research_id: state.research_id, view: 'plan' },
    note: '진행 요약입니다. 전체 후보·조회 이력·요건 평가는 collections의 페이지로 모두 확인하세요. 원문은 evidence_ids로 읽으세요. job.completed는 한 작업의 종료이며 법률 판단 완료가 아닙니다.' };
  // A small preview helps clients find the exact source handle; totals/pages always expose omissions.
  out.evidence_index = lists.evidence_index.slice(-4);
  out.review_worklist = lists.worklist.slice(0, 2);
  out.requirements = [...lists.requirements].sort((a, b) => Number(b.missing && b.status !== 'not_required_for_question')
    - Number(a.missing && a.status !== 'not_required_for_question')).slice(0, 4);
  out.previews = { evidence_index: { total: lists.evidence_index.length, shown: out.evidence_index.length },
    review_worklist: { total: lists.worklist.length, shown: out.review_worklist.length },
    requirements: { total: lists.requirements.length, shown: out.requirements.length } };
  for (const key of ['review_worklist', 'evidence_index', 'requirements']) {
    while (storedBytes(out) > sizeLimit && out[key].length) { out[key].pop(); out.previews[key].shown--; }
  }
  if (storedBytes(out) > sizeLimit) throw new ServiceError(500, 'RESEARCH_SUMMARY_CONTRACT');
  return out;
}
