// Local evaluation only. Does not bind a public interface or change production configuration.
import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { appendFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../dist/app.js';
import { KoreanLawClient, koreanLawOptionsFromEnv, LawMcpError } from '../dist/koreanLawClient.js';
import { createLegalRetrievalClient } from '../dist/taxLawClient.js';
import { observeSearch } from '../dist/researchSearch.js';

const [scenario, output] = process.argv.slice(2);
if (!scenario || !output) throw Error('Usage: scenario output-directory');
await mkdir(output, { recursive: true });
const live = ['remaining_two_homes', 'ordinary_two_homes', 'statute_only', 'raw_lookup_only'].includes(scenario);
const client = createLegalRetrievalClient(new KoreanLawClient(koreanLawOptionsFromEnv(process.env)), process.env);
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const redact = value => JSON.parse(JSON.stringify(value).replace(/v1\.\d{13}\.[a-f0-9]{64}\.[a-f0-9]{64}/g, '[REDACTED_SESSION]'));
let writes = Promise.resolve();
const record = (file, value) => { writes = writes.then(() => appendFile(resolve(output, file), JSON.stringify(redact(value)) + '\n')); };
const number = '2099두10001', successor = '2099두10002';
function synthetic(tool, args) {
  // Clearly marked synthetic legal corpus: tests behavior, never represents real legislation.
  const server = { name: 'synthetic-authority-pilot', version: '1' };
  const text = s => ({ server, result: { content: [{ type: 'text', text: s }] } });
  const zero = { server, result: { structuredContent: { total: 0, items: [], page: args.page ?? 1, limit: args.limit ?? 20 } } };
  if (tool === 'get_law_text') return text('법령명: 합성평가법\n시행일: 20990101\n제1조(합성 취득 요건)\n[가상 평가 자료: 실제 법률 아님] 2099년 1월 1일부터 자산을 취득한 자는 등록 요건 없이 특례를 적용한다.\n제2조(합성 부칙)\n[가상 평가 자료] 2099년 1월 1일 이후 취득에만 제1조 개정 규정을 적용하며 종전의 등록 요건을 폐지한다.');
  if (tool === 'search_law') return text('검색 결과 (총 1건):\n1. 합성평가법 [현행]\n   - 법령ID: pilot-law\n   - MST: pilot-version\n   - 공포일: 20981201 / 시행일: 20990101\n   - 구분: 합성 평가 자료');
  if (tool === 'search_decisions') {
    if (scenario === 'provider_failure') throw new LawMcpError(504, 'MCP_TIMEOUT', 'Controlled provider failure');
    let row = '';
    if (scenario !== 'administrative_only' && !String(args.query).includes('적용 제외') && !String(args.query).includes('예외')) {
      const next = String(args.query).includes(number);
      if (!String(args.query).includes(successor)) row = `[${next ? 'pilot-next' : 'pilot-old'}] 가상 평가 판결\n  사건번호: ${next ? successor : number}\n  법원: 대법원\n  선고일: ${next ? '20990201' : '20980101'}\n`;
    }
    return text(`판례 검색 결과 (총 ${row ? 1 : 0}건, ${args.page ?? 1}페이지)\n${row}`);
  }
  if (tool === 'get_decision_text') {
    const next = args.id === 'pilot-next';
    return text(`기본 정보:\n사건번호: ${next ? successor : number}\n법원: 대법원\n선고일: ${next ? '20990201' : '20980101'}\n전문:\n[가상 평가 판결: 실제 판례 아님] ${next ? '개정 합성평가법 제1조는 2099년 이후 취득에 등록을 요구하지 않는다. 종전 판결은 구법 사건이므로 신법 취득에는 그대로 적용할 수 없다.' : '2098년 취득 사건에 적용되는 구 합성평가법은 취득과 등록을 모두 요구한다. 등록하지 않았으므로 구법상 특례를 적용하지 않는다.'}`);
  }
  if (tool.startsWith('search_tax_')) {
    const doc = { ntstDcmId: 'pilot-admin', documentNumber: '합성해석-2099-1', issuingAgency: '국세청', documentType: '질의회신', productionDate: '2099-01-15', title: '가상 평가 행정해석' };
    return tool === 'search_tax_interpretations' && !String(args.query).includes('변경') ? { server, result: { structuredContent: { total: 1, items: [doc], page: args.page ?? 1, limit: args.limit ?? 20 } } } : zero;
  }
  if (['lookup_tax_document', 'get_tax_document'].includes(tool)) return { server, result: { structuredContent: { document: { ntstDcmId: 'pilot-admin', documentNumber: '합성해석-2099-1', issuingAgency: '국세청', documentType: '질의회신', productionDate: '2099-01-15', answer: '[가상 평가 해석: 실제 예규 아님] 신법상 2099년 취득자는 등록하지 않아도 특례가 적용된다.' } } } };
  throw new LawMcpError(400, 'PILOT_UNSUPPORTED_TOOL', 'Synthetic corpus supports only documented atomic tools');
}
const law = {
  get releaseVersion() { return client.releaseVersion; }, get taxlawRelease() { return client.taxlawRelease; },
  listTools: () => client.listTools(), close: () => client.close(),
  callTool: async (tool, args) => {
    const started = Date.now();
    try { const result = live ? await client.callTool(tool, args) : synthetic(tool, args);
      record('sources.jsonl', { at: new Date(started).toISOString(), tool, args, duration_ms: Date.now() - started, response_hash: sha(result),
        ...(tool.startsWith('search_') ? { search: observeSearch(tool, args, result) } : {}), status: 'returned', memory: process.memoryUsage() }); return result;
    } catch (e) { record('sources.jsonl', { at: new Date(started).toISOString(), tool, args, duration_ms: Date.now() - started, error_code: e.code,
      ...(e.result ? { source_error: e.result.structuredContent?.error, result_hash: sha(e.result) } : {}) }); throw e; }
  },
};
const built = createApp({ law, env: { TAXLAB_PUBLIC_ACCESS: '1', TAXLAB_PUBLIC_SESSION_SECRET: randomBytes(32).toString('hex') } });
const server = createServer((req, res) => {
  const started = Date.now(), inputs = [], outputs = []; req.on('data', x => inputs.push(x));
  const write = res.write.bind(res), end = res.end.bind(res);
  res.write = function(chunk, ...args) { if (chunk) outputs.push(Buffer.from(chunk)); return write(chunk, ...args); };
  res.end = function(chunk, ...args) { if (chunk) outputs.push(Buffer.from(chunk)); return end(chunk, ...args); };
  res.on('finish', () => {
    const parse = chunks => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } };
    const request = parse(inputs); if (request?.method !== 'tools/call') return;
    record('mcp.jsonl', { started_at: new Date(started).toISOString(), duration_ms: Date.now() - started, status: res.statusCode,
      request, response: parse(outputs), memory: process.memoryUsage() });
  });
  built.app(req, res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await writeFile(resolve(output, 'ready.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp`, scenario, source_mode: live ? 'live_official' : 'controlled_synthetic', pid: process.pid }));
let closed = false;
async function close() { if (closed) return; closed = true; server.close(); await built.close(); await writes; process.exit(0); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
process.stdin.setEncoding('utf8'); process.stdin.on('data', s => { if (s.trim() === 'quit') void close(); });
