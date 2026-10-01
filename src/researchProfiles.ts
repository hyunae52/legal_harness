import { ResearchPlan, type Plan } from './researchContracts.js';

/** Facts are requested, never invented from an anticipated legal answer. */
export function applyResearchProfiles(input: Plan): Plan {
  const plan = structuredClone(input);
  const facts = [
    ['housing_timeline', '세대 전체 주택의 취득·처분 순서 및 각 시점 주택 수'],
    ['homes_before_new_acquisition', '신규주택 취득 직전 세대의 실제 주택 수와 그 산정 근거'],
    ['housing_special_exceptions', '상속·혼인·등록임대 등 별도 특례에 해당할 사실의 유무'],
  ];
  const dates = ['old_home_acquired', 'new_home_acquired', 'old_home_transferred'];
  for (const issue of plan.issues) {
    if (issue.profile !== 'temporary_two_homes' && !/일시적\s*2주택|마지막\s*2주택/.test(issue.question + (plan.issues.length === 1 ? ' ' + plan.query : ''))) continue;
    issue.profile = 'temporary_two_homes';
    for (const [id, description] of facts) {
      if (!plan.facts.some(f => f.id === id)) plan.facts.push({ id, description, status: 'unknown', value: null, source: '' });
      if (!issue.required_fact_ids.includes(id)) issue.required_fact_ids.push(id);
    }
    const before = plan.facts.find(f => f.id === 'homes_before_new_acquisition');
    const knownSingle = before?.status === 'provided' && /^(?:1|1주택|1채)$/.test(before.value?.trim() ?? '');
    // There is no disposal date to invent for the ordinary one-home -> two-home control.
    const applicableDates = !knownSingle && /다주택|(?:[3-9]|다른|중간)\s*주택|마지막\s*2주택/.test(plan.query + ' ' + issue.question)
      ? [...dates, 'other_homes_disposed'] : dates;
    for (const role of applicableDates) {
      if (!plan.event_dates.some(d => d.role === role)) plan.event_dates.push({ role, value: null, precision: 'unknown', basis: 'unknown', source: '' });
      if (!issue.required_date_roles.includes(role)) issue.required_date_roles.push(role);
    }
  }
  return ResearchPlan.parse(plan);
}
