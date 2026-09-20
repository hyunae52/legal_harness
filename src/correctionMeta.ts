// Common public contracts for MCP clients and GPT Actions; no runtime credentials.
export const correctionInstructions = '사용자가 반박하거나 새 공식 근거가 나와 기존 답변의 정정 필요성을 인정한 경우, 오류를 설명하고 prepare_correction_pr로 공개 가능한 정정안·출처·다음 점검 항목을 준비하세요. 반환된 public_preview와 question을 보여주며 “이 정정 내용을 PR로 제안할까요?”라고 묻고 동의를 기다리세요. 사용자가 동의한 뒤에만 고정된 proposal_id/hash/token으로 create_correction_pr를 호출하세요. 성공 시 실제 PR 링크를 전달하세요. 응답 유실 시 새 요청을 만들지 말고 get_correction_pr로 기존 상태를 확인하세요. 상태가 retry_available이면 반환된 retry 인수로 기존 동의의 create_correction_pr를 한 번 재시도할 수 있습니다. 자동 반복하지 마세요. 대상 저장소 변경이나 구형 동의로 재개가 거부되면 새 제안 내용을 보여주고 다시 동의를 받으세요. 논쟁이 해결되지 않았거나 근거가 부족하면 단정하지 말고 추가 확인하세요. 작성 AI의 판단을 별도 AI 검수 통과로 주장하지 마세요.';
type InputSchema = { type: 'object'; properties: Record<string, object>; required: string[]; additionalProperties: false };
const str = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const id = { type: 'string', format: 'uuid' };
export const correctionInputs: Record<'prepare' | 'confirm' | 'status' | 'search', InputSchema> = {
  prepare: { type: 'object', additionalProperties: false,
    required: ['request_id', 'title', 'previous_claim', 'correction', 'why', 'sources', 'keywords', 'next_checks', 'public_safe'], properties: {
      request_id: id, title: str(120), previous_claim: str(2000), correction: str(3000), why: str(2000),
      sources: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false,
        required: ['url', 'title', 'supporting_excerpt'], properties: { url: { type: 'string', format: 'uri', maxLength: 1000 }, title: str(200), supporting_excerpt: str(1500) } } },
      keywords: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 2, maxLength: 50 } },
      next_checks: { type: 'array', minItems: 1, maxItems: 8, items: str(400) },
      public_safe: { type: 'boolean', enum: [true], description: 'Only public source material and anonymized correction text; never private case originals or credentials.' },
    } },
  confirm: { type: 'object', additionalProperties: false, required: ['proposal_id', 'proposal_hash', 'confirmation_token', 'confirm'], properties: {
    proposal_id: id, proposal_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, confirmation_token: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    confirm: { type: 'boolean', enum: [true], description: 'Set true only after the user explicitly agrees to publishing the shown preview to the named GitHub repository.' },
  } },
  status: { type: 'object', additionalProperties: false, required: ['proposal_id'], properties: { proposal_id: id } },
  search: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: str(20000) } },
};
const response = { description: 'Proposal or actual PR status. Uncertain states are not success.', content: { 'application/json': { schema: {
  type: 'object', properties: {
    proposal_id: id, state: { type: 'string' }, proposal_hash: { type: 'string' }, confirmation_token: { type: 'string' },
    question: { type: 'string' }, public_preview: { type: 'object', properties: { schema_version: { type: 'integer' }, proposal: { type: 'object', properties: correctionInputs.prepare.properties, additionalProperties: true } }, additionalProperties: true },
    target_repository: { type: 'string' }, next_action: { type: 'string' }, pr_url: { type: 'string' }, message: { type: 'string' },
    retry: { type: 'object', properties: { tool: { type: 'string', enum: ['create_correction_pr'] }, arguments: correctionInputs.confirm }, additionalProperties: false },
  }, additionalProperties: true,
} } } };
export const correctionActionPaths = Object.fromEntries([
  ['/api/corrections/prepare', 'prepare_correction_pr', 'prepare', false, 'Prepare a public correction after a rebuttal or stronger official evidence. Show preview and ask permission; this does not publish to GitHub.'],
  ['/api/corrections/create', 'create_correction_pr', 'confirm', true, 'Create an actual draft PR ONLY after the user agrees to publishing the exact preview. Never merge.'],
  ['/api/corrections/status', 'get_correction_pr', 'status', false, 'Check an existing proposal or PR after a lost response; never invent a PR URL.'],
].map(([path, operationId, input, consequential, description]) => [path, { post: {
  operationId, description, 'x-openai-isConsequential': consequential,
  requestBody: { required: true, content: { 'application/json': { schema: correctionInputs[input as 'prepare' | 'confirm' | 'status'] } } },
  responses: { '200': response, default: { description: 'Input, authentication, capacity or provider error.' } },
} }]));
