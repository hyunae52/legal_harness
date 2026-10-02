import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { inputDiagnostics } from '../dist/inputDiagnostics.js';
import { researchSchemas, researchTools } from '../dist/researchContracts.js';
import { coverageFixture, coverageReview } from './fixtures/authority-provider.mjs';

const schema = researchTools.find(t => t.name === 'review_legal_reasoning').inputSchema;
const claimSchema = schema.properties.analysis.items.properties.claims.items;
const citationSchema = claimSchema.properties.citations.items;
const findHint = (d, path) => d.schema_hints?.find(h => h.paths.includes(path));

test('FR-07: observed N2 missing requirements, citation reason and malformed counter receive exact parent schemas and can be repaired locally', async t => {
  const f = coverageFixture(); t.after(() => f.service.close());
  const s = await f.law(await f.start()), valid = coverageReview(s), bad = structuredClone(valid);
  delete bad.analysis[0].claims[0].requirements;
  delete bad.analysis[0].claims[0].citations[0].reason;
  bad.analysis[0].counter_evidence = [{ invented_key_with_secret: 'private-value' }];
  const parsed = researchSchemas.review_legal_reasoning.safeParse(bad); assert.equal(parsed.success, false);
  const d = inputDiagnostics(parsed.error, schema);
  assert.deepEqual(findHint(d, 'analysis.0.claims.0')?.schema, claimSchema);
  assert.deepEqual(findHint(d, 'analysis.0.claims.0.citations.0')?.schema, citationSchema);
  assert.deepEqual(findHint(d, 'analysis.0.counter_evidence.0')?.schema, schema.properties.analysis.items.properties.counter_evidence.items);
  assert.equal(JSON.stringify(d).includes('invented_key_with_secret'), false); assert.equal(JSON.stringify(d).includes('private-value'), false);
  assert.equal(d.code, 'INVALID_INPUT'); assert.equal(d.recovery.review_performed, false);
  // Only flagged fields are repaired from the real source/claim, never a server-invented value.
  bad.analysis[0].claims[0].requirements = valid.analysis[0].claims[0].requirements;
  bad.analysis[0].claims[0].citations[0].reason = valid.analysis[0].claims[0].citations[0].reason;
  bad.analysis[0].counter_evidence = valid.analysis[0].counter_evidence;
  assert.deepEqual(researchSchemas.review_legal_reasoning.parse(bad), valid);
  const reviewed = await f.service.run('review_legal_reasoning', { kind: 'auth_user', id: 'authority-fixture' }, bad);
  assert.equal(reviewed.status, 'blocked'); assert.equal(reviewed.question_scope_complete, false);
  assert.ok(reviewed.findings.some(x => x.code === 'DEFINITIVE_WITH_GAPS'));
  assert.equal(f.calls.length, 1, 'input repair must not require another source call');
});

test('FR-07/08: empty requirements, array item errors, duplicate parent structures and unknown keys have bounded non-reflective diagnostics', () => {
  const error = new z.ZodError([
    { code: 'too_small', minimum: 1, type: 'array', inclusive: true, exact: false, path: ['analysis', 0, 'claims', 0, 'requirements'], message: 'private-error-message' },
    { code: 'too_small', minimum: 1, type: 'array', inclusive: true, exact: false, path: ['analysis', 0, 'claims', 1, 'requirements'], message: 'private-error-message' },
    { code: 'invalid_type', expected: 'string', received: 'object', path: ['analysis', 0, 'unknowns', 0], message: 'private-error-message' },
    { code: 'unrecognized_keys', keys: ['private-key'], path: ['analysis', 0, 'timing'], message: 'private-error-message' },
  ]);
  const d = inputDiagnostics(error, schema), hint = findHint(d, 'analysis.0.claims.0');
  assert.equal(hint?.schema.properties.requirements.minItems, 1);
  assert.ok(hint.paths.includes('analysis.0.claims.1'), 'identical parent schemas are shared instead of copied');
  assert.deepEqual(findHint(d, 'analysis.0.unknowns')?.schema, schema.properties.analysis.items.properties.unknowns);
  assert.deepEqual(findHint(d, 'analysis.0.timing')?.schema, schema.properties.analysis.items.properties.timing);
  assert.equal(JSON.stringify(d).includes('private-'), false);
  const many = inputDiagnostics(new z.ZodError(Array.from({ length: 300 }, (_, i) => ({
    code: 'invalid_type', expected: 'string', received: 'object', path: ['analysis', i, 'unknowns', 0], message: 'private-value',
  }))), schema);
  assert.equal(many.issues_truncated, true); assert.ok(many.fields.length <= 24);
  assert.ok(Buffer.byteLength(JSON.stringify(many)) <= 16000);
  // A whole over-budget fragment is omitted, never turned into a weaker schema.
  const root = inputDiagnostics(new z.ZodError([{ code: 'unrecognized_keys', keys: ['private-key'], path: [], message: 'private-value' }]), schema);
  if (root.schema_hints.length) assert.deepEqual(root.schema_hints[0].schema, schema);
  else assert.equal(root.schema_hints_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(root)) <= 16000);
});
