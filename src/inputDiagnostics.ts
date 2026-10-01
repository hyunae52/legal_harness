import type { ZodError } from 'zod';

/** Explain the contract without echoing submitted values, unknown keys, or custom error messages. */
export function inputDiagnostics(error: ZodError) {
  return { code: 'INVALID_INPUT', fields: error.issues.map(i => i.path.join('.')),
    issues: error.issues.slice(0, 24).map(i => ({ path: i.path.join('.'), code: i.code,
      ...(i.code === 'invalid_enum_value' ? { allowed_values: i.options } : {}),
      ...(i.code === 'invalid_type' ? { expected_type: i.expected } : {}),
      ...(i.code === 'invalid_string' && typeof i.validation === 'string' ? { format: i.validation } : {}),
      ...(i.code === 'too_small' ? { minimum: i.minimum, inclusive: i.inclusive } : {}),
      ...(i.code === 'too_big' ? { maximum: i.maximum, inclusive: i.inclusive } : {}),
      ...(i.code === 'unrecognized_keys' ? { hint: 'Remove fields not declared in this tool input schema.' } : {}),
    })), issues_truncated: error.issues.length > 24 };
}
