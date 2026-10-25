import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { classifyAudit, runtimeAudit, verifyParseBoundary } from '../scripts/audit-runtime.mjs';
import { DraftSchema } from '../dist/contracts.js';
import { researchSchemas, researchTools } from '../dist/researchContracts.js';
import { inputDiagnostics } from '../dist/inputDiagnostics.js';

const legacy = ['node_modules/kordoc/node_modules/zod', 'node_modules/korean-law-mcp/node_modules/kordoc/node_modules/zod'];
const report = () => ({ auditReportVersion: 2, metadata: { vulnerabilities: { total: 3 } }, vulnerabilities: {
  zod: { severity: 'high', nodes: [...legacy], via: [{ name: 'zod', url: 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5' }] },
  kordoc: { severity: 'high', nodes: ['node_modules/kordoc', 'node_modules/korean-law-mcp/node_modules/kordoc'], via: ['zod'] },
  'korean-law-mcp': { severity: 'high', nodes: ['node_modules/korean-law-mcp'], via: ['kordoc'] },
} });

test('runtime audit: only the reviewed advisory in exact unused parser dependencies is eligible', () => {
  assert.deepEqual(classifyAudit(report()).blocked, []);
  const newAdvisory = report(); newAdvisory.vulnerabilities.zod.via.push({ name: 'zod', url: 'https://github.com/advisories/new' });
  assert.deepEqual(classifyAudit(newAdvisory).blocked.sort(), ['kordoc', 'korean-law-mcp', 'zod']);
  const rootValidator = report(); rootValidator.vulnerabilities.zod.nodes.push('node_modules/zod');
  assert.ok(classifyAudit(rootValidator).blocked.includes('zod'));
  const independent = report(); independent.vulnerabilities.kordoc.via.push({ name: 'kordoc', url: 'https://github.com/advisories/new' });
  assert.ok(classifyAudit(independent).blocked.includes('kordoc'));
  const other = report(); other.vulnerabilities.express = { severity: 'moderate', nodes: ['node_modules/express'], via: ['other'] };
  other.metadata.vulnerabilities.total++;
  assert.deepEqual(classifyAudit(other).blocked, ['express']);
  assert.throws(() => classifyAudit({ ...report(), error: { code: 'network' } }), /AUDIT_UNAVAILABLE/);
  assert.throws(() => classifyAudit({ ...report(), vulnerabilities: {} }), /AUDIT_INCOMPLETE/);
});

test('runtime audit: installed parser bytes, resolution and consumers must retain the reviewed boundary', async () => {
  const root = resolve('.');
  const manifest = JSON.parse(await readFile('upstreams/kordoc-parse-audit.json', 'utf8'));
  assert.equal((await runtimeAudit(root, report())).exception.advisory, manifest.advisory);
  const changed = structuredClone(manifest);
  changed.packages[0].files['node_modules/kordoc/dist/index.js'] = '0'.repeat(64);
  await assert.rejects(verifyParseBoundary(root, changed), /PARSER_BOUNDARY_CHANGED/);
  const file = resolve('src/audit-boundary-probe.ts');
  await writeFile(file, "import { createFormatProfile } from 'kordoc';\n", { flag: 'wx' });
  try {
    await assert.rejects(verifyParseBoundary(root, manifest), /PARSER_CONSUMER_CHANGED/);
    await writeFile(file, "const path = 'kordoc'; void import(path);\n");
    await assert.rejects(verifyParseBoundary(root, manifest), /UNREVIEWED_COMPUTED_IMPORT/);
  } finally { await unlink(file); }
});

test('patched validation rejects oversized collections before visiting elements; normal input and diagnostics stay valid', () => {
  let visited = 0;
  const item = { get gate_id() { visited++; return 'QG-TEST-1'; } };
  const result = DraftSchema.safeParse({ draft_answer: 'valid draft', gate_assessments: Array(20_000).fill(item) });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some(i => i.code === 'too_big'));
  assert.equal(visited, 0);
  const map = z.map(z.string(), z.string().superRefine(() => { visited++; })).max(2);
  assert.equal(map.safeParse(new Map([['a','one'],['b','two'],['c','three']])).success, false);
  assert.equal(visited, 0);
  const valid = DraftSchema.parse({ draft_answer: 'valid draft', facts: { known: true }, skip_gates: [] });
  assert.equal(valid.mode, 'strict'); assert.deepEqual(valid.facts, { known: true });
  const failure = z.object({ mode: z.enum(['strict','warn']), id: z.guid() }).safeParse({ mode: 'private-invalid', id: 'private-id' });
  const diagnostic = inputDiagnostics(failure.error);
  assert.deepEqual(diagnostic.issues[0].allowed_values, ['strict','warn']);
  assert.equal(diagnostic.issues[0].code, 'invalid_enum_value');
  assert.equal(diagnostic.issues[1].format, 'uuid');
  assert.ok(!JSON.stringify(diagnostic).includes('private-'));
});

test('Zod 4 public input schemas retain optional defaults, string-keyed records and bounded expression refs', () => {
  const input = { research_id: '11111111-1111-1111-1111-111111111111' };
  assert.equal(researchSchemas.get_legal_research.safeParse(input).success, true);
  const review = researchTools.find(t => t.name === 'review_legal_reasoning').inputSchema;
  assert.ok(review.$defs.TestExpression4);
  assert.ok(JSON.stringify(review).includes('#/$defs/TestExpression4'));
  assert.ok(Buffer.byteLength(JSON.stringify(review)) < 100_000);
});
