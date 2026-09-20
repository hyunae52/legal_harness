import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, DraftSchema, ServiceError } from './contracts.js';

const RuleSchema = z.object({
  id: z.string().regex(/^QG-[A-Z]+-\d+$/), case_id: z.string().regex(/^FC-\d+$/),
  name: z.string().min(1), cues: z.array(z.string().min(1)).min(1),
  required_facts: z.array(z.string().min(1)).min(1), guidance: z.string().min(1),
  legal_status: z.literal('research_required'), version: z.literal(1),
}).strict();
type Rule = z.infer<typeof RuleSchema>;
export type CheckStatus = 'pass' | 'fail' | 'needs_info' | 'unverified' | 'not_applicable' | 'skipped';

/** Cues select questions to ask; they are never evidence of a legal violation. */
export class GateEngine {
  readonly version: string;
  readonly rules: Rule[];
  constructor(directory = fileURLToPath(new URL('../rules/', import.meta.url))) {
    try {
      const names = z.array(z.string().regex(/^QG-[A-Z]+-\d+\.json$/)).min(10).max(100).parse(JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')));
      this.rules = names.map(name => RuleSchema.parse(JSON.parse(readFileSync(resolve(directory, name), 'utf8'))));
      if (new Set(this.rules.map(r => r.id)).size !== this.rules.length || this.rules.some((r, i) => names[i] !== `${r.id}.json`)) throw new Error('Duplicate rule');
      this.version = digest(this.rules);
    } catch { throw new ServiceError(503, 'RULESET_UNAVAILABLE'); }
  }
  validate(input: unknown, upstreamVersion: string) {
    const draft = DraftSchema.parse(input);
    if (draft.skip_gates.some(id => !this.rules.some(r => r.id === id))) throw new ServiceError(400, 'UNKNOWN_GATE');
    const text = `${draft.query ?? ''}\n${draft.draft_answer}`;
    const candidates = this.rules.filter(r => r.cues.some(c => text.includes(c)));
    const checks = candidates.map(rule => {
      const missing = rule.required_facts.filter(f => draft.facts[f] === undefined || draft.facts[f] === null);
      const status: CheckStatus = draft.skip_gates.includes(rule.id) ? 'skipped' : missing.length ? 'needs_info' : 'unverified';
      return { id: rule.id, case_id: rule.case_id, status, required_facts: missing, guidance: rule.guidance,
        scope: 'legal_applicability', reason: status === 'unverified' ? 'Official legal basis and draft/facts agreement have not been verified.' : status };
    });
    // A separate, useful arithmetic check. It makes no claim about the legally
    // correct allocation basis or the factual truth of caller-supplied amounts.
    const arithmetic = draft.facts.allocation;
    const arithmeticChecks: Array<{id: string; status: CheckStatus; scope: string; reason: string}> = [];
    if (arithmetic !== undefined) {
      const parsed = z.object({ total: z.number().int().nonnegative().safe(), parts: z.array(z.number().int().nonnegative().safe()).min(1).max(100) }).strict().parse(arithmetic);
      const sum = parsed.parts.reduce((a, b) => a + BigInt(b), 0n);
      arithmeticChecks.push({ id: 'ARITH-SUM-01', status: sum === BigInt(parsed.total) ? 'pass' : 'fail', scope: 'caller_supplied_arithmetic', reason: 'Sum of submitted allocations compared with submitted total; not a legal allocation ruling.' });
    }
    const all = [...checks, ...arithmeticChecks];
    const blockingBypass = draft.force || draft.mode === 'warn';
    const bypassed = blockingBypass || draft.skip_gates.length > 0;
    const complete = all.length > 0 && all.every(c => ['pass', 'fail', 'not_applicable'].includes(c.status));
    const scopedPass = complete && !bypassed && all.every(c => c.status !== 'fail');
    return { receipt_id: randomUUID(), checked_at: new Date().toISOString(), draft_hash: digest(draft.draft_answer), facts_hash: digest(draft.facts),
      rules_version: this.version, upstream_version: upstreamVersion, policy_version: 'scope-v1',
      checks: all, coverage: all.length ? 'limited' : 'no_coverage', assessment_complete: complete,
      scoped_pass: scopedPass, passed: false, // Legacy field never certifies an unassessed legal answer.
      legal_verification: 'unverified', draft_facts_agreement: 'unverified',
      blocked: !blockingBypass && all.some(c => c.status === 'fail'),
      bypass: { requested: bypassed, skipped: draft.skip_gates, reason: draft.bypass_reason ?? null },
      message: '제출한 사실·산식과 확인 범위에 대한 결과입니다. 법률 결론과 초안 전체가 검증된 것은 아닙니다.' };
  }
}
