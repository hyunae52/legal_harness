/** Finite labels only: never persist exception messages, arbitrary codes or payload fields. */
export const failureLabels = {
  input: '입력 오류', not_found: '조회 결과 없음', state: '작업 상태·검토 조건',
  access: '인증·권한', limit: '요청·용량 제한', upstream: '외부 조회·연결',
  internal: '서버 내부', unknown: '원인 미분류', unrecorded: '원인 기록 없음',
} as const;
export type FailureCategory = keyof typeof failureLabels;
const groups: Record<Exclude<FailureCategory, 'unrecorded'>, string> = {
  input: `INVALID_INPUT INVALID_JSON INVALID_ARGUMENTS INVALID_PARAMETER MCP_INVALID_ARGUMENTS MCP_UNKNOWN_TOOL
    NTS_ID_REQUIRED AMBIGUOUS_DOCUMENT_NUMBER BATCH_NOT_SUPPORTED UNKNOWN_GATE
    GATE_APPLICABILITY_INVALID INVALID_REPRODUCTION_EVIDENCE RESEARCH_CURSOR_INVALID
    RESEARCH_INVALID_ARGUMENTS RESEARCH_MANIFEST_INVALID RESEARCH_VIEW_INVALID
    REQUIREMENT_CITATION_INVALID REQUIREMENT_DUPLICATE REQUIREMENT_PROFILE_INVALID
    REQUIREMENT_PROFILE_REQUIRED REQUIREMENT_SCOPE_INVALID REASONING_REFERENCE_INVALID
    REVIEW_CHECK_REMAP_INVALID REVIEW_CHECK_REMOVAL_INVALID REVIEW_FEEDBACK_SOURCE_INVALID
    REVIEW_FINDING_GAP_INVALID REVIEW_FINDING_INVALID REVIEW_RESPONSE_INVALID REVIEW_CURSOR_INVALID
    INTERVIEW_ANSWER_KIND SCOPE_PROMOTION_INVALID`,
  not_found: `NOT_FOUND LAW_NOT_FOUND RESEARCH_NOT_FOUND RESEARCH_EVIDENCE_NOT_FOUND CANDIDATE_NOT_FOUND
    REQUIREMENT_NOT_FOUND RECEIPT_NOT_FOUND SESSION_NOT_FOUND SESSION_EXPIRED CORRECTION_NOT_FOUND CORRECTION_EXPIRED`,
  state: `RESEARCH_DATE_MISMATCH RESEARCH_REQUEST_CONFLICT RESEARCH_REUSE_INCOMPLETE
    RESEARCH_REVISION_CHANGED RESEARCH_STATE_CHANGED RESEARCH_SUMMARY_CONTRACT RESEARCH_TOOL_NOT_ALLOWED
    REQUIREMENT_BASIS_REQUIRED REQUIREMENT_EVIDENCE_NOT_CURRENT REQUIREMENT_SCOPE_RECONCILIATION_REQUIRED
    REQUIREMENT_SOURCE_INCOMPLETE REQUIREMENT_SOURCE_SCOPE REQUIREMENT_VERSION_MISMATCH
    CANDIDATE_DOCUMENT_MISMATCH IDEMPOTENCY_CONFLICT INTERVIEW_QUESTION_CHANGED
    REVIEW_ARTIFACT_STALE REVIEW_AUTHOR_RESPONSE_REQUIRED REVIEW_CHECK_UNMAPPED REVIEW_FINDING_UNMAPPED
    REVIEW_PACKET_ALREADY_ACCEPTED REVIEW_PACKET_REQUIRED REVIEW_PACKET_STALE REVIEW_RESULT_CONFLICT
    REVIEW_STRUCTURE_STALE REVIEW_STRUCTURE_UNRESOLVED REVIEWED_HEAD_MISMATCH REASONING_V2_DISABLED
    CORRECTION_ALREADY_CLOSED CORRECTION_CONFIRMATION_MISMATCH CORRECTION_CONTENT_CHANGED
    CORRECTION_PATH_CONFLICT CORRECTION_PR_AMBIGUOUS CORRECTION_PR_CHANGED CORRECTION_REPO_INVALID
    CORRECTION_SCOPE_CHANGED CORRECTION_TARGET_CHANGED CORRECTION_TARGET_UNBOUND CORRECTION_TREE_INCOMPLETE
    DUPLICATE_PATCH_PATH PATCH_COMPARISON_MISMATCH PATCH_CONTENT_MISMATCH PR_HEAD_OR_STATE_CHANGED
    AMBIGUOUS_PR SOURCE_IDENTITY_UNRESOLVED USE_CORRECTION_PR USE_SUBMIT_FAILURE`,
  access: `UNAUTHORIZED FORBIDDEN PUBLIC_SESSION_INVALID PUBLIC_SESSION_REQUIRED PUBLIC_SESSION_WITH_AUTH
    INVALID_ACTOR INVALID_CLIENT_ADDRESS CLIENT_ADDRESS_UNAVAILABLE ORIGIN_REJECTED QUERY_AUTH_REMOVED
    PRIVATE_CONTENT_BLOCKED PRIVATE_SESSION_IN_CONTENT PUBLICATION_BLOCKED PATCH_OUTSIDE_AUTOMATION_SCOPE`,
  limit: `RATE_LIMITED AT_CAPACITY MCP_AT_CAPACITY RATE_ACTOR_CAPACITY QUEUE_CAPACITY SESSION_CAPACITY
    LOOKUP_RATE_LIMIT REQUEST_RATE_LIMIT RESEARCH_CAPACITY
    RESEARCH_BUSY RESEARCH_MANIFEST_CAPACITY RESEARCH_EVIDENCE_TOO_LARGE REVIEW_RECEIPT_CAPACITY
    REVIEW_ROUND_LIMIT SOURCE_REFRESH_CAPACITY CORRECTION_BUSY CORRECTION_DAILY_LIMIT
    CORRECTION_TOO_LARGE ATTEMPT_LIMIT BODY_TOO_LARGE PATCH_TOO_LARGE RESPONSE_TOO_LARGE`,
  upstream: `TIMEOUT REQUEST_TIMEOUT UPSTREAM_ERROR EXTERNAL_API_ERROR UPSTREAM_TIMEOUT UPSTREAM_NO_DATA
    ANNEX_BODY_UNAVAILABLE PARSE_ERROR DETAIL_NOT_AVAILABLE LOOKUP_INCOMPLETE
    MCP_UNAVAILABLE MCP_TIMEOUT MCP_CONNECTION_ERROR MCP_CLOSED TAXLAW_INVALID_RESPONSE
    SOURCE_REFRESH_TIMEOUT SOURCE_REFRESH_STOPPED SOURCE_VERIFIER_UNAVAILABLE CORRECTION_PR_UNAVAILABLE
    ECONNRESET ECONNREFUSED ETIMEDOUT ENOTFOUND EAI_AGAIN`,
  internal: `INTERNAL_ERROR DB_UNAVAILABLE AUTH_UNAVAILABLE RULESET_UNAVAILABLE MAINTENANCE_UNAVAILABLE
    MCP_NOT_CONFIGURED TAXLAW_NOT_CONFIGURED DOCUMENT_PARSER_NOT_CONFIGURED GITHUB_NOT_CONFIGURED
    CORRECTION_CONFIG_MISSING SHUTTING_DOWN DRAIN_TIMEOUT`,
  unknown: 'MCP_TOOL_ERROR UNCLASSIFIED_ERROR UNCLASSIFIED_EXCEPTION',
};
const categories = new Map<string, FailureCategory>();
for (const [category, codes] of Object.entries(groups)) {
  for (const code of codes.trim().split(/\s+/)) categories.set(code, category as FailureCategory);
}
export const normalizeFailureCode = (code: unknown): string =>
  typeof code === 'string' && categories.has(code) ? code : 'UNCLASSIFIED_ERROR';
export const failureCategory = (code: string): FailureCategory =>
  code === 'UNRECORDED' ? 'unrecorded' : categories.get(code) ?? 'unknown';

// Only inspect protocol envelopes, small JSON parts and the law provider's fixed
// leading [CODE] format. Never search prose/messages for keywords or keep their text.
const own = (value: unknown, key: string): unknown => value && typeof value === 'object'
  ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const privateCodes = new WeakMap<object, string>();
/** Keep only a fixed code when public sanitization must omit the original diagnostic.
 * Weak metadata is neither serialized nor added to the client's response object. */
export function withUsageFailureCode<T extends object>(result: T, error: unknown): T {
  privateCodes.set(result, usageFailureCode(error, true));
  return result;
}
export function usageFailureCode(value: unknown, thrown = false): string {
  if (value && typeof value === 'object' && privateCodes.has(value)) return privateCodes.get(value)!;
  let budget = 24;
  const visit = (node: unknown, depth = 0): string | undefined => {
    if (--budget < 0 || depth > 5 || !node || typeof node !== 'object') return undefined;
    const code = own(node, 'code');
    // Prefer a provider's structured code over the generic MCP_TOOL_ERROR wrapper.
    if (typeof code === 'string' && code !== 'MCP_TOOL_ERROR' && categories.has(code)) return code;
    for (const key of ['error', 'structuredContent', 'result', 'body']) {
      const found = visit(own(node, key), depth + 1); if (found) return found;
    }
    const content = own(node, 'content');
    if (Array.isArray(content)) for (let i = 0; i < Math.min(3, content.length); i++) {
      const part = own(content, String(i)), text = own(part, 'text');
      if (own(part, 'type') !== 'text' || typeof text !== 'string') continue;
      const label = /^\[([A-Z][A-Z_0-9]{0,63})\](?:\s|$)/.exec(text.slice(0, 96))?.[1];
      if (label && categories.has(label)) return label;
      if (text.length > 16384 || !text.trimStart().startsWith('{')) continue;
      try { const found = visit(JSON.parse(text), depth + 1); if (found) return found; } catch { /* Not structured diagnostics. */ }
    }
    return code === 'MCP_TOOL_ERROR' ? code : undefined;
  };
  try { return visit(value) ?? (thrown ? 'UNCLASSIFIED_EXCEPTION' : 'UNCLASSIFIED_ERROR'); }
  catch { return thrown ? 'UNCLASSIFIED_EXCEPTION' : 'UNCLASSIFIED_ERROR'; }
}
