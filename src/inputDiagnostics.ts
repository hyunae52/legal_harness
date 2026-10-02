import type { ZodError } from 'zod';
import { ServiceError } from './contracts.js';

type Schema = Record<string, any>;
const object = (value: unknown): value is Schema => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const branches = (node: Schema): Schema[] => [node, ...['anyOf', 'oneOf', 'allOf'].flatMap(k =>
  Array.isArray(node[k]) ? node[k].filter(object).flatMap(branches) : [])];
function locate(schema: Schema, path: (string | number)[]): Schema[] {
  let nodes = [schema];
  for (const part of path) nodes = nodes.flatMap(branches).flatMap(node => {
    const child = typeof part === 'number' ? node.items
      : object(node.properties) && Object.hasOwn(node.properties, part) ? node.properties[part] : undefined;
    return object(child) ? [child] : [];
  });
  return nodes;
}
export const reviewRecoveryGuide = { origin: 'legal-harness', purpose: 'review_recovery', instructions: [
  '형식 오류는 지적 경로만 수정하고 나머지 필드를 불필요하게 다시 만들지 마세요. 형식상 유효한 값도 현재 상태·실제 근거와 일치하는지는 별도 검토해야 합니다. stale revision/state와 인용 오류는 최신 세션에서 확인하세요.',
  'claims.requirements에는 그 법률 주장에 실제 필요한 조건을 적으세요. 빈 배열·가짜 조건으로 형식을 채우지 마세요. 단순 범위·한계 설명은 별도 설명에 두되 답변에 남긴 법률 주장을 검수에서 숨기지 마세요.',
  '복구할 수 없는 입력 오류나 근거 공백이 남으면 확인한 근거와 미확인점을 구분한 제한 답변으로 마치세요. INVALID_INPUT은 이번 초안 미검수입니다. blocked/needs_info는 그대로 공개하고 이전 검수나 중간 초안을 최종 답변의 PASS로 대신하지 마세요. 새 연구로 예산을 초기화하지 마세요.',
] };

/** Created only for request-schema failures; provider/internal Zod errors must not acquire the caller's schema. */
export class ToolInputError extends ServiceError {
  constructor(public readonly body: ReturnType<typeof inputDiagnostics>) { super(400, 'INVALID_INPUT'); }
}

/** Explain the contract without echoing submitted values, unknown keys, or custom error messages. */
export function inputDiagnostics(error: ZodError, publicSchema?: unknown) {
  const schema = object(publicSchema) ? publicSchema : undefined;
  const safePath = (path: (string | number)[]) => schema && !locate(schema, path).length
    ? '[schema-path-unavailable]' : path.join('.').slice(0, 192);
  const selected = error.issues.slice(0, 24);
  const out = { code: 'INVALID_INPUT', fields: [] as string[],
    issues: selected.map(i => ({ path: safePath(i.path), code: i.code,
      ...(i.code === 'invalid_enum_value' ? { allowed_values: i.options } : {}),
      ...(i.code === 'invalid_type' ? { expected_type: i.expected } : {}),
      ...(i.code === 'invalid_string' && typeof i.validation === 'string' ? { format: i.validation } : {}),
      ...(i.code === 'too_small' ? { minimum: i.minimum, inclusive: i.inclusive } : {}),
      ...(i.code === 'too_big' ? { maximum: i.maximum, inclusive: i.inclusive } : {}),
      ...(i.code === 'unrecognized_keys' ? { hint: 'Remove fields not declared in this tool input schema.' } : {}),
    })), issues_truncated: error.issues.length > 24,
    ...(schema ? { recovery: { ...reviewRecoveryGuide, review_performed: false },
      schema_hints: [] as { paths: string[]; schema: Schema }[], schema_hints_truncated: false,
      schema_note: '공개 입력 스키마의 해당 부분입니다. refine 등 추가 검증이나 법적 정확성을 보장하지 않습니다. 실제 입력 검증과 현재 근거 검사가 최종 기준입니다.' } : {}) };
  // Bound all diagnostic fields, not only issues. Never cut an individual schema into a weaker contract.
  out.fields = [...new Set(out.issues.map(i => i.path))];
  const size = () => Buffer.byteLength(JSON.stringify(out), 'utf8');
  while (size() > 16_000 && out.issues.length) {
    out.issues.pop(); out.fields = [...new Set(out.issues.map(i => i.path))]; out.issues_truncated = true;
  }
  if (schema) {
    const hints = new Map<string, { paths: string[]; schema: Schema }>();
    for (const issue of selected) {
      const path = issue.code === 'unrecognized_keys' ? issue.path : issue.path.slice(0, -1);
      for (const node of locate(schema, path)) {
        const key = JSON.stringify(node), old = hints.get(key), at = safePath(path);
        if (old) { if (!old.paths.includes(at)) old.paths.push(at); }
        else hints.set(key, { paths: [at], schema: structuredClone(node) });
      }
    }
    for (const hint of hints.values()) {
      out.schema_hints!.push(hint);
      if (size() > 16_000) { out.schema_hints!.pop(); out.schema_hints_truncated = true; }
    }
    if (error.issues.length > selected.length) out.schema_hints_truncated = true;
  }
  return out;
}
