import { digest, ServiceError } from './contracts.js';
import { ResearchPlan, type Plan, type InterviewAnswer } from './researchContracts.js';

export type Deferral = { kind: 'fact' | 'date'; id: string; reason: string };
interface InterviewState { research_id: string; revision: number; state_version: number; plan: Plan; deferrals: Deferral[] }
export function interviewState(session: InterviewState) {
  const pending = new Map<string, { target: { kind: 'fact' | 'date'; id: string }; question: string; issue_ids: string[];
    deferred: boolean; reason: string | null }>();
  for (const issue of session.plan.issues) {
    for (const [kind, ids] of [['fact', issue.required_fact_ids], ['date', issue.required_date_roles]] as const) {
      for (const id of ids) {
        const fact = session.plan.facts.find(f => f.id === id);
        const date = session.plan.event_dates.find(d => d.role === id);
        if (kind === 'fact' ? fact!.status === 'provided' : date!.precision === 'day' && date!.basis === 'provided') continue;
        const key = kind + ':' + id, existing = pending.get(key);
        if (existing) { existing.issue_ids.push(issue.id); continue; }
        const deferred = session.deferrals.find(d => d.kind === kind && d.id === id);
        const question = kind === 'fact'
          ? `다음 사실을 확인해 주세요: ${fact!.description}. 실제 값·상황과 확인 근거를 알려주세요. 모르면 확인 불가로 남길 수 있습니다.`
          : `${id} 시점의 정확한 연월일과 확인 근거를 알려주세요. 현재 기록: ${date!.value ?? '미상'} (${date!.precision}/${date!.basis}). 더 정확히 모르면 아는 범위만 답해 주세요.`;
        pending.set(key, { target: { kind, id }, question, issue_ids: [issue.id], deferred: Boolean(deferred), reason: deferred?.reason ?? null });
      }
    }
  }
  const unresolved = [...pending.values()], next = unresolved.find(item => !item.deferred);
  return { next_action: next ? 'ask_user' : unresolved.length ? 'conditional_or_withheld' : 'research_sources_and_review',
    next_question: next ? { question_id: digest({ research_id: session.research_id, revision: session.revision,
      state_version: session.state_version, target: next.target }), target: next.target, question: next.question,
      issue_ids: next.issue_ids, reason: '등록된 쟁점의 필수 사실 또는 날짜가 아직 확인되지 않았습니다.' } : null,
    unresolved_count: unresolved.length, unresolved, coverage: 'registered_requirements_only',
    fact_verification: 'client_asserted', legal_verification: 'unverified' };
}

export function applyInterviewAnswer(session: InterviewState, input: InterviewAnswer) {
  if (input.expected_state_version !== session.state_version) throw new ServiceError(409, 'RESEARCH_STATE_CHANGED');
  const question = interviewState(session).next_question;
  if (!question || question.question_id !== input.question_id) throw new ServiceError(409, 'INTERVIEW_QUESTION_CHANGED');
  const target = question.target, answer = input.answer;
  if (answer.kind !== 'unknown' && answer.kind !== target.kind) throw new ServiceError(400, 'INTERVIEW_ANSWER_KIND');
  let plan = structuredClone(session.plan);
  const deferrals = session.deferrals.filter(d => d.kind !== target.kind || d.id !== target.id);
  if (answer.kind === 'unknown') deferrals.push({ ...target, reason: answer.reason });
  else if (answer.kind === 'fact') {
    const fact = plan.facts.find(f => f.id === target.id)!;
    Object.assign(fact, { status: 'provided', value: answer.value, source: answer.source });
  } else {
    const date = plan.event_dates.find(d => d.role === target.id)!;
    Object.assign(date, { basis: 'provided', precision: answer.precision, value: answer.value, source: answer.source });
    if (answer.precision !== 'day') deferrals.push({ ...target, reason: '정확한 일자는 미확인. 제출된 ' + answer.precision + ' 정밀도를 유지합니다.' });
  }
  plan = ResearchPlan.parse(plan);
  return { plan, deferrals, changed_plan: answer.kind !== 'unknown' };
}
