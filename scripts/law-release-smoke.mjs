// Explicit, read-only checks for the law provider selected by the application's environment.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv.includes('--live')) throw new Error('Use --live to query public official legal sources.');
const appRoot = process.env.LAW_SMOKE_APP_ROOT || process.cwd();
const { createKoreanLawClient } = await import(pathToFileURL(resolve(appRoot, 'dist/koreanLawClient.js')));
const client = createKoreanLawClient();
const cases = [];
const checks = [
  {
    name: 'event_date_article', tool: 'get_law_text',
    args: { lawId: '001586', jo: '제18조', efYd: '20220301' },
    verify(text) {
      assert.match(text, /법령명: 국세기본법/);
      assert.match(text, /제18조/);
      const effective = /^시행일:\s*(\d{8})/m.exec(text)?.[1];
      assert.ok(effective && effective <= '20220301', 'Must return the version in force by the requested date');
      assert.match(text, /efYd=20220301/);
      return { effective_date: effective };
    },
  },
  {
    name: 'renamed_law_history', tool: 'legal_analysis',
    args: { mode: 'applicable_law', lawName: '소방시설 설치 및 관리에 관한 법률 시행령', date: '2015-03-01', jo: '제11조' },
    verify(text) {
      assert.match(text, /기준일에 시행 중이던 버전/);
      assert.match(text, /당시 법령명/);
      assert.match(text, /설치[ㆍ·\s]*유지 및 안전관리에 관한 법률 시행령/);
      assert.doesNotMatch(text, /당시 이 법령은 시행 전/);
      assert.match(text, /기준일 시점 조문/);
      return { renamed_history_found: true };
    },
  },
  {
    name: 'large_law_annex', tool: 'get_annexes',
    args: { lawName: '도로교통법 시행규칙', query: '별표1' },
    verify(text) {
      assert.match(text, /도로교통법 시행규칙/);
      assert.match(text, /별표\s*1(?!\d)/);
      assert.match(text, /신호기의 종류 및 만드는 방식/);
      assert.match(text, /파일 형식: HWP/);
      assert.doesNotMatch(text, /UPSTREAM_RESPONSE_TOO_LARGE|UPSTREAM_BODY_BUDGET_EXCEEDED/);
      return { annex_found: true };
    },
  },
  {
    name: 'historical_annex', tool: 'get_annexes',
    args: { lawName: '소방시설 설치 및 관리에 관한 법률 시행령', query: '별표5', date: '2015-03-01' },
    verify(text) {
      assert.match(text, /2015[.\-]0?3[.\-]0?1/);
      assert.match(text, /설치[ㆍ·\s]*유지 및 안전관리에 관한 법률 시행령/);
      assert.match(text, /별표\s*5(?!\d)/);
      assert.match(text, /시행 2015\.01\.08/);
      assert.match(text, /제26033호/);
      assert.match(text, /소화설비/);
      return { historical_annex_found: true };
    },
  },
  {
    name: 'annex_visible_tables', tool: 'get_annexes',
    args: { lawName: '대기환경보전법 시행령', query: '별표8' },
    verify(text) {
      assert.match(text, /대기환경보전법 시행령/);
      assert.match(text, /별표\s*8(?!\d)/);
      assert.match(text, /파일 형식: HWP/);
      const tables = (text.match(/<table\b/g) || []).length;
      // This annex has five visible tables; its invisible layout frame must
      // not turn the whole document into one giant HTML table.
      assert.equal(tables, 5, 'Expected separate visible tables, not the outer layout frame');
      return { visible_tables: tables };
    },
  },
  {
    name: 'annex_fraction', tool: 'get_annexes',
    args: { lawName: '할부거래에 관한 법률 시행령', query: '별표1' },
    verify(text) {
      assert.match(text, /할부거래에 관한 법률 시행령/);
      assert.match(text, /별표\s*1(?!\d)/);
      assert.match(text, /파일 형식: HWP/);
      assert.match(text.replace(/\s+/g, ''), /A=P×r×\$\\frac\{\(1\+r\)\^\{n\}\}\{\(1\+r\)\^\{n\}-1\}\$/);
      return { fraction_preserved: true };
    },
  },
];
async function check(item) {
  const start = performance.now();
  try {
    const response = await client.callTool(item.tool, item.args);
    const text = response.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    assert.ok(text.length > 100, 'Expected substantive source text');
    const detail = item.verify(text);
    cases.push({ name: item.name, status: 'pass', milliseconds: Math.round(performance.now() - start), response_bytes: Buffer.byteLength(text), ...detail });
  } catch (error) {
    cases.push({ name: item.name, status: 'failed', milliseconds: Math.round(performance.now() - start), code: error.code || error.name });
  }
}
try {
  const catalog = await client.listTools();
  assert.equal(catalog.server?.name, 'korean-law');
  assert.equal(catalog.server?.version, '4.15.1');
  const annex = catalog.tools.find(t => t.name === 'get_annexes');
  assert.ok(annex?.inputSchema.properties?.date);
  // Distinct cold requests in batches matching the application's work limit.
  for (let i = 0; i < checks.length; i += 3) await Promise.all(checks.slice(i, i + 3).map(check));
  const report = { status: cases.every(c => c.status === 'pass') ? 'pass' : 'failed',
    checked_at: new Date().toISOString(), node: process.version, upstream: catalog.server,
    tool_count: catalog.tools.length, maximum_concurrent_calls: 3, cases,
    scope: 'Public source retrieval and historical version selection; legal applicability still requires interpretation.' };
  if (process.env.LAW_RELEASE_SMOKE_REPORT) await writeFile(process.env.LAW_RELEASE_SMOKE_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (report.status !== 'pass') process.exitCode = 1;
} finally { await client.close(); }
