import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DocumentParser, documentParserFromEnv, attachmentUrl, parserPin, attachmentByteLimit } from '../dist/documentParser.js';
import { TaxAttachmentClient } from '../dist/taxAttachment.js';
import { adaptResearchEvidence, researchSourceTools, boundEvidence } from '../dist/researchEvidence.js';
import { LegalRetrievalClient } from '../dist/taxLawClient.js';
import { sourceReadingGuide } from '../dist/evidence.js';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../dist/app.js';

const url = 'https://taxlaw.nts.go.kr/downloadFile.do?fleId=300000000001139785&fleSn=969300';
const bytes = Buffer.from('synthetic-download');
const sha = createHash('sha256').update(bytes).digest('hex');
const row = { documentNumber: '2024심사636', title: '합성 결정', documentType: '감사원 심사청구', registrationDate: '2025-11-26',
  attachment: { fleId: '300000000001139785', fleSn: '969300', downloadUrl: url } };
const parsed = (text = '합성 원문') => ({ ok: true, format: 'pdf', text, units: [{ index: 1, page_number: 1, start: 0, end: text.length }],
  page_count: 1, offset_unit: 'utf16_code_unit', warnings: [], completeness: 'unverified', ocr_performed: false });
function fixture({ result = parsed(), rows = [row], total = rows.length, downloader = async () => bytes, parse = async () => result } = {}) {
  const calls = [];
  const source = { callTool: async (name, args) => { calls.push({ name, args }); return { result: { structuredContent: { total, items: rows }, content: [] } }; } };
  return { calls, client: new TaxAttachmentClient(source, { parse, close: async () => {} }, downloader) };
}
const request = { document_number: '2024-심사-636' };

test('source download accepts only the exact official file endpoint and IDs', () => {
  assert.equal(attachmentUrl(url).href, url);
  for (const candidate of ['http:' + url.slice(6), url.replace('taxlaw.nts.go.kr', 'localhost'), url.replace('.go.kr', '.go.kr.evil.test'),
    url + '&extra=1', url + '&fleSn=1', url + '#page=1', url.replace('https://', 'https://user@'), url.replace('/downloadFile.do', '/other.do'),
    url.replace('969300', '../etc/passwd'), url.replace('.go.kr/', '.go.kr:8443/')]) {
    assert.throws(() => attachmentUrl(candidate), e => e.code === 'INVALID_ATTACHMENT_URL');
  }
});

test('attachment identity is resolved from the official search; output binds file hash and page', async () => {
  const { client, calls } = fixture(); const response = await client.callTool(request), doc = response.result.structuredContent.document;
  assert.deepEqual(calls, [{ name: 'search_tax_decisions', args: { type: 'audit_appeal', query: '2024심사636', limit: 10 } }]);
  assert.equal(doc.attachment.sha256, sha); assert.equal(doc.sourceUrl, url); assert.equal(doc.extraction.units[0].source_url, url + '#page=1');
  assert.equal(doc.extraction.body_scope, 'body_returned'); assert.equal(doc.extraction.completeness, 'unverified');
  assert.equal(doc.decisionDate, undefined); // posting date must not become the decision date
  assert.ok(sourceReadingGuide('read_tax_attachment', response.result));
  assert.equal(response.server.version, parserPin.version);
});

test('ambiguous, missing, incomplete or mismatched attachments are never fetched', async () => {
  for (const [options, code] of [
    [{ rows: [] }, 'ATTACHMENT_NOT_FOUND'], [{ rows: [row, row] }, 'AMBIGUOUS_ATTACHMENT'],
    [{ total: 11 }, 'ATTACHMENT_LOOKUP_INCOMPLETE'], [{ rows: [{ ...row, attachment: {} }] }, 'ATTACHMENT_METADATA_UNAVAILABLE'],
    [{ rows: [{ ...row, attachment: { ...row.attachment, fleSn: '1' } }] }, 'ATTACHMENT_IDENTITY_MISMATCH'],
  ]) {
    let fetched = false; const { client } = fixture({ ...options, downloader: async () => { fetched = true; return bytes; } });
    await assert.rejects(client.callTool(request), e => e.code === code); assert.equal(fetched, false);
  }
});

test('no URL, file path, format override, OCR flag or invented issuer enters the public request', async () => {
  const { client } = fixture();
  for (const field of ['url', 'path', 'fileName', 'format', 'ocr', 'issuingAgency']) await assert.rejects(client.callTool({ ...request, [field]: 'arbitrary' }));
  await assert.rejects(client.callTool({ document_number: 'unrelated keyword' }));
});

test('pagination preserves surrogate pairs and requires the same file on continuation', async () => {
  const text = '가'.repeat(499) + '😀' + '끝'.repeat(900);
  const { client } = fixture({ result: parsed(text) });
  const a = (await client.callTool({ ...request, limit: 500 })).result.structuredContent.document;
  assert.equal(a.fullText.length, 499); assert.equal(a.extraction.body_scope, 'partial');
  assert.equal(a.extraction.next_arguments.offset, 499);
  const b = (await client.callTool(a.extraction.next_arguments)).result.structuredContent.document;
  assert.equal(b.fullText.slice(0, 2), '😀'); assert.equal(b.extraction.units[0].document_start, 499);
  assert.equal(a.fullText + b.fullText, text.slice(0, b.extraction.end));
  await assert.rejects(client.callTool({ ...request, offset: 1 }), /Continuation/);
  await assert.rejects(client.callTool({ ...request, offset: 500, expected_sha256: sha }), e => e.code === 'INVALID_ATTACHMENT_OFFSET');
  await assert.rejects(client.callTool({ ...request, expected_sha256: '0'.repeat(64) }), e => e.code === 'ATTACHMENT_CHANGED');
});

test('HWP, empty PDF pages and parser warnings never become full body confirmation', async () => {
  for (const warning of ['HWP_PAGE_NUMBERS_UNVERIFIED', 'EMPTY_PAGE_OR_SCAN', 'PARSER_WARNING']) {
    const data = parsed(); data.warnings = [{ code: warning }];
    if (warning.startsWith('HWP')) { data.format = 'hwp'; data.page_count = null; data.units[0].page_number = null; }
    const response = await fixture({ result: data }).client.callTool(request);
    const receipt = adaptResearchEvidence('read_tax_attachment', request, response);
    assert.equal(receipt.body_scope, 'partial'); assert.equal(receipt.completeness, 'unverified');
    if (data.format === 'hwp') { assert.equal(receipt.passages[0].page_number, null); assert.equal(receipt.passages[0].source_url, url); }
  }
});

test('research evidence retains actual offsets, page URLs, file version and authority from the official row', async () => {
  assert.ok(researchSourceTools.has('read_tax_attachment'));
  const response = await fixture().client.callTool(request);
  const receipt = adaptResearchEvidence('read_tax_attachment', request, response);
  assert.equal(receipt.source_kind, 'extracted_attachment'); assert.equal(receipt.document_version, sha);
  assert.equal(receipt.identity.kind, 'tax_appeal'); assert.equal(receipt.identity.date, null);
  assert.equal(receipt.upstream_commit, parserPin.commit); assert.equal(receipt.passages[0].source_sha256, sha);
  const passage = receipt.passages[0];
  assert.equal(response.result.structuredContent.document.fullText.slice(passage.start, passage.end), passage.text);
  assert.equal(passage.source_url, url + '#page=1');
  const shortened = boundEvidence(receipt, 700); assert.equal(shortened.body_scope, 'partial');
});

test('one attachment job at a time; shutdown aborts downloads and releases the parser', async () => {
  let release, entered; const ready = new Promise(r => entered = r);
  const { client } = fixture({ downloader: async (_url, signal) => { entered(); return new Promise((resolve, reject) => {
    release = () => resolve(bytes); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }); } });
  const running = client.callTool(request); const handled = assert.rejects(running, /aborted/); await ready;
  await assert.rejects(client.callTool(request), e => e.code === 'DOCUMENT_PARSER_BUSY');
  await client.close(); await handled; release();
  await assert.rejects(client.callTool(request), e => e.code === 'DOCUMENT_PARSER_STOPPED');
});

test('invalid attachment provenance cannot become verified body evidence', async () => {
  for (const corrupt of [d => d.extraction.units = [], d => d.extraction.units[0].end++,
    d => d.extraction.units[0].source_url = 'https://example.test/', d => d.extraction.units[0].document_start++,
    d => d.extraction.units[0].start = '0']) {
    const response = await fixture().client.callTool(request); corrupt(response.result.structuredContent.document);
    const receipt = adaptResearchEvidence('read_tax_attachment', request, response);
    assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.body_scope, 'unknown'); assert.deepEqual(receipt.passages, []);
  }
});

test('parser tool is advertised/routed only with a configured attachment provider', async () => {
  const law = { listTools: async () => ({ tools: [] }), callTool: async () => { throw Error('Wrong provider'); }, close: async () => {} };
  const plain = new LegalRetrievalClient(law);
  assert.equal((await plain.listTools()).tools.length, 0);
  await assert.rejects(plain.callTool('read_tax_attachment', request), e => e.code === 'DOCUMENT_PARSER_NOT_CONFIGURED');
  const client = new LegalRetrievalClient(law, undefined, fixture().client);
  assert.equal((await client.listTools()).tools[0].name, 'read_tax_attachment');
  assert.equal((await client.callTool('read_tax_attachment', request)).kind, 'retrieval');
  await client.close();
});

test('the public remote MCP exposes the parser and preserves reading guidance and provenance', async t => {
  const law = { listTools: async () => ({ tools: [] }), callTool: async () => { throw Error('Wrong provider'); }, close: async () => {} };
  const runtime = createApp({ law: new LegalRetrievalClient(law, undefined, fixture().client),
    env: { TAXLAB_PUBLIC_ACCESS: '1', TAXLAB_PUBLIC_SESSION_SECRET: 'synthetic-parser-session-key-0123456789abcdef' } });
  const server = createServer(runtime.app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'attachment-contract', version: '1' });
  t.after(async () => { await client.close(); await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'read_tax_attachment'));
  const response = await client.callTool({ name: 'read_tax_attachment', arguments: request });
  assert.equal(response.structuredContent.document.attachment.sha256, sha);
  assert.ok(response.content.some(c => c.type === 'text' && c.text.includes('source_reading_guide')));
  assert.equal((await (await fetch(base + '/health')).json()).document_parser.version, parserPin.version);
});

function pdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count ' + pages.length + ' /Kids [' + pages.map((_, i) => (4 + i * 2) + ' 0 R').join(' ') + '] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const text of pages) {
    const content = text ? 'BT /F1 12 Tf 40 700 Td (' + text + ') Tj ET' : '';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (objects.length + 2) + ' 0 R >>');
    objects.push('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
  }
  let document = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(document)); document += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const xref = Buffer.byteLength(document); document += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) document += String(offset).padStart(10, '0') + ' 00000 n \n';
  return Buffer.from(document + 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}

test('real pinned kordoc extracts PDF pages, HWP and HWPX; bad/empty inputs fail closed', async t => {
  const parser = documentParserFromEnv(); t.after(() => parser.close());
  const result = await parser.parse(pdf(['First page legal conditions', 'Second page exceptions']));
  assert.equal(result.page_count, 2); assert.equal(result.units.length, 2);
  assert.match(result.text.slice(result.units[1].start, result.units[1].end), /Second page exceptions/);
  assert.equal(result.units[1].page_number, 2);
  const mixed = await parser.parse(pdf(['Readable page', '']));
  assert.ok(mixed.warnings.some(w => w.code === 'EMPTY_PAGE_OR_SCAN' && w.page === 2));
  const hwp = await parser.parse(readFileSync(new URL('./fixtures/documents/standard.hwp', import.meta.url)));
  assert.equal(hwp.format, 'hwp'); assert.ok(hwp.text.includes('이것은 굵은 글씨입니다.')); assert.equal(hwp.page_count, null);
  const hwpx = await parser.parse(readFileSync(new URL('./fixtures/documents/standard.hwpx', import.meta.url)));
  assert.equal(hwpx.format, 'hwpx'); assert.ok(hwpx.text.includes('테스트 본문과 예외 조항입니다.')); assert.equal(hwpx.page_count, null);
  for (const payload of [Buffer.from('<html>Error</html>'), pdf([''])]) {
    await assert.rejects(parser.parse(payload), e => ['UNSUPPORTED_ATTACHMENT_FORMAT', 'NO_EXTRACTABLE_TEXT'].includes(e.code));
  }
  await assert.rejects(parser.parse(Buffer.alloc(attachmentByteLimit + 1)), e => e.code === 'ATTACHMENT_SIZE_LIMIT');
  await assert.rejects(parser.parse(pdf(Array(201).fill('Page limit'))), e => e.code === 'EXTRACTION_LIMIT');
});

test('timed-out parser work is terminated before the slot is released', async () => {
  const parser = new DocumentParser(30, fileURLToPath(new URL('./fixtures/document-parser-hang.mjs', import.meta.url)));
  await assert.rejects(parser.parse(Buffer.from('%PDF-')), e => e.code === 'DOCUMENT_PARSE_TIMEOUT');
  await parser.close();
  await assert.rejects(parser.parse(Buffer.from('%PDF-')), e => e.code === 'DOCUMENT_PARSER_STOPPED');
});
