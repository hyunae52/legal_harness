/** One read-only, offline extraction per child. The parent enforces timeout, heap/RSS and output limits. */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';

// Set before loading the third-party parser. No network/model downloads or subprocesses.
const denyNetwork = () => { throw Error('Document parser network disabled'); };
Object.assign(http, { request: denyNetwork, get: denyNetwork });
Object.assign(https, { request: denyNetwork, get: denyNetwork });
Object.assign(net, { connect: denyNetwork, createConnection: denyNetwork });
Object.assign(net.Socket.prototype, { connect: denyNetwork });
Object.assign(tls, { connect: denyNetwork });
globalThis.fetch = denyNetwork;
syncBuiltinESMExports();
// Third-party diagnostic stdout must not contaminate the JSON protocol.
console.log = console.warn = console.error = () => {};

const MAX_INPUT = 8 * 1024 * 1024, MAX_TEXT = 500_000, MAX_PAGES = 200;
const failure = (code: string) => ({ ok: false as const, code });
async function extract() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.from(raw); size += chunk.length;
    if (size > MAX_INPUT) return failure('ATTACHMENT_SIZE_LIMIT');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) return failure('ATTACHMENT_SIZE_LIMIT');
  const pdf = bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  const hwp = bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  const zip = bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
  const hwp3 = bytes.subarray(0, 17).toString('ascii') === 'HWP Document File';
  if (!pdf && !hwp && !zip && !hwp3) return failure('UNSUPPORTED_ATTACHMENT_FORMAT');
  const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('kordoc')), 'utf8'));
  // The tested release manifest moves with automatic dependency updates.
  const pin = JSON.parse(readFileSync(new URL('../upstreams/document-parser.json', import.meta.url), 'utf8'));
  if (pin.package !== 'kordoc' || packageInfo.name !== pin.package || packageInfo.version !== pin.version)
    return failure('PARSER_VERSION_MISMATCH');
  const { parse } = await import('kordoc');
  const result = await parse(bytes, { ocr: false, formulaOcr: false, images: false,
    removeHeaderFooter: false, scriptTags: true, dedupeRunningHeaders: false, pages: '1-200' });
  if (!['pdf', 'hwp', 'hwp3', 'hwpx'].includes(result.fileType)) return failure('UNSUPPORTED_ATTACHMENT_FORMAT');
  if (!result.success) return failure(['ENCRYPTED', 'DRM_PROTECTED'].includes(result.code ?? '') ? 'PROTECTED_DOCUMENT' : 'DOCUMENT_PARSE_FAILED');
  if (!result.markdown.trim()) return failure('NO_EXTRACTABLE_TEXT');
  if ((result.pageCount ?? 1) > MAX_PAGES) return failure('EXTRACTION_LIMIT');
  const warnings: { code: string; page?: number }[] = (result.warnings ?? []).map(w => ({ code: w.code, ...(w.page ? { page: w.page } : {}) }));
  let pieces: { page_number: number | null; content: string }[], total: number | null;
  if (result.fileType === 'pdf') {
    total = result.pageCount ?? null;
    if (!total || !result.pages || result.pages.some(p => p.pageNumber < 1 || p.pageNumber > total!)) return failure('PAGE_PROVENANCE_UNAVAILABLE');
    const pages = new Map(result.pages.map(p => [p.pageNumber, p.markdown]));
    if (pages.size !== result.pages.length) return failure('PAGE_PROVENANCE_UNAVAILABLE');
    pieces = Array.from({ length: total }, (_, i) => ({ page_number: i + 1, content: pages.get(i + 1) ?? '' }));
    for (const p of pieces) if (!p.content.trim()) warnings.push({ code: 'EMPTY_PAGE_OR_SCAN', page: p.page_number! });
  } else {
    // HWP layout caches / section counts are not reliably physical page boundaries.
    total = null; pieces = [{ page_number: null, content: result.markdown }];
    warnings.push({ code: 'HWP_PAGE_NUMBERS_UNVERIFIED' });
  }
  const text = pieces.map(p => p.content).join('\n\n');
  if (!text.trim()) return failure('NO_EXTRACTABLE_TEXT');
  if (text.length > MAX_TEXT || warnings.length > 210) return failure('EXTRACTION_LIMIT');
  let offset = 0;
  const units = pieces.map((p, i) => { const start = offset; offset += p.content.length;
    const unit = { index: i + 1, page_number: p.page_number, start, end: offset }; offset += 2; return unit; });
  return { ok: true, format: result.fileType, text, units, page_count: total, offset_unit: 'utf16_code_unit',
    warnings, completeness: 'unverified', ocr_performed: false };
}
try { process.stdout.write(JSON.stringify(await extract()) + '\n'); }
catch { process.stdout.write(JSON.stringify(failure('DOCUMENT_PARSE_FAILED')) + '\n'); }
