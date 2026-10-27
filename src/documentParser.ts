import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { get, type RequestOptions } from 'node:https';
import { lookup } from 'node:dns';
import { BlockList } from 'node:net';
import { z } from 'zod';
import { LawMcpError } from './koreanLawClient.js';

export const parserPin = JSON.parse(readFileSync(new URL('../upstreams/document-parser.json', import.meta.url), 'utf8')) as { package: string; version: string; commit: string };
export const attachmentByteLimit = 8 * 1024 * 1024;
const worker = fileURLToPath(new URL('./documentParserWorker.js', import.meta.url));
// Dependencies may be hoisted outside this package after npm installation.
const parserModules = fileURLToPath(new URL('../../', import.meta.resolve('kordoc')));
export const ParsedDocument = z.object({
  ok: z.literal(true), format: z.enum(['pdf', 'hwp', 'hwp3', 'hwpx']), text: z.string().min(1).max(500_000),
  page_count: z.number().int().min(1).max(200).nullable(), offset_unit: z.literal('utf16_code_unit'),
  units: z.array(z.object({ index: z.number().int().positive(), page_number: z.number().int().positive().nullable(),
    start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict()).min(1).max(200),
  warnings: z.array(z.object({ code: z.string().regex(/^[A-Z_]{1,80}$/), page: z.number().int().positive().optional() }).strict()).max(210),
  completeness: z.literal('unverified'), ocr_performed: z.literal(false),
}).strict();
export type ParsedDocument = z.infer<typeof ParsedDocument>;
export const parserError = (status: number, code: string) => new LawMcpError(status, code,
  '첨부 원문을 읽지 못했거나 일부만 확인했습니다. 오류를 문서 부존재 또는 법률 결론으로 해석하지 마세요.');

/** Only the NTS file endpoint observed in upstream attachment metadata. No user URLs. */
export function attachmentUrl(raw: unknown): URL {
  let url: URL;
  try { url = new URL(z.string().max(512).parse(raw)); } catch { throw parserError(502, 'INVALID_ATTACHMENT_URL'); }
  const keys = [...url.searchParams.keys()].sort();
  if (url.protocol !== 'https:' || url.hostname !== 'taxlaw.nts.go.kr' || url.port || url.username || url.password || url.hash
    || url.pathname !== '/downloadFile.do' || keys.join(',') !== 'fleId,fleSn'
    || !/^\d{18}$/.test(url.searchParams.get('fleId') ?? '') || !/^\d{1,12}$/.test(url.searchParams.get('fleSn') ?? '')) {
    throw parserError(502, 'INVALID_ATTACHMENT_URL');
  }
  return url;
}
const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(ip, prefix);
const publicLookup: RequestOptions['lookup'] = (hostname, _options, callback) => lookup(hostname, { family: 4 }, (error, address) => {
  if (error) callback(error, '', 4);
  else if (blocked.check(address, 'ipv4')) callback(new Error('Non-public source address'), '', 4);
  else callback(null, address, 4);
});
export function downloadAttachment(raw: unknown, signal: AbortSignal): Promise<Buffer> {
  const url = attachmentUrl(raw);
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks: Buffer[] = [];
    const request = get(url, { agent: false, lookup: publicLookup, family: 4, signal,
      headers: { 'User-Agent': 'TaxLab-Document-Reader/1.0', 'Accept-Encoding': 'identity' } }, response => {
      const fail = (code: string) => { response.destroy(); reject(parserError(502, code)); };
      const length = Number(response.headers['content-length']);
      if (response.statusCode !== 200) return fail('ATTACHMENT_DOWNLOAD_FAILED'); // redirects are deliberately not followed
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') return fail('ATTACHMENT_ENCODING_UNSUPPORTED');
      if (length > attachmentByteLimit) return fail('ATTACHMENT_SIZE_LIMIT');
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > attachmentByteLimit) fail('ATTACHMENT_SIZE_LIMIT');
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', () => reject(parserError(502, 'ATTACHMENT_DOWNLOAD_FAILED')));
    });
    const timer = setTimeout(() => request.destroy(parserError(504, 'ATTACHMENT_DOWNLOAD_TIMEOUT')), 12_000);
    request.on('error', error => reject(error instanceof LawMcpError ? error : parserError(502, 'ATTACHMENT_DOWNLOAD_FAILED')));
    request.on('close', () => clearTimeout(timer));
  });
}

/** Short-lived process: malformed/native parser failures cannot crash the Express process. */
export class DocumentParser {
  private child?: ChildProcess;
  private stopped = false;
  private running?: Promise<ParsedDocument>;
  constructor(private readonly timeoutMs = 20_000, private readonly workerPath = worker) {}
  parse(bytes: Buffer, signal?: AbortSignal): Promise<ParsedDocument> {
    if (this.stopped) return Promise.reject(parserError(503, 'DOCUMENT_PARSER_STOPPED'));
    if (this.running) return Promise.reject(parserError(429, 'DOCUMENT_PARSER_BUSY'));
    if (signal?.aborted) return Promise.reject(parserError(504, 'DOCUMENT_PARSE_TIMEOUT'));
    if (bytes.length > attachmentByteLimit || !bytes.length) return Promise.reject(parserError(413, 'ATTACHMENT_SIZE_LIMIT'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'TMP'].includes(k.toUpperCase())));
    Object.assign(env, { DO_NOT_TRACK: '1' });
    this.running = new Promise<ParsedDocument>((resolve, reject) => {
      const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
      const child = spawn(process.execPath, [permissionFlag, '--disable-proto=throw', '--no-addons',
        '--max-old-space-size=160', '--max-semi-space-size=8',
        '--allow-fs-read=' + parserModules,
        '--allow-fs-read=' + fileURLToPath(new URL('../dist', import.meta.url)),
        '--allow-fs-read=' + fileURLToPath(new URL('../package.json', import.meta.url)),
        '--allow-fs-read=' + fileURLToPath(new URL('../upstreams/document-parser.json', import.meta.url)),
        '--allow-fs-read=' + this.workerPath, this.workerPath], {
        cwd: tmpdir(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      const chunks: Buffer[] = []; let size = 0, failure: LawMcpError | undefined;
      const stop = (code: string) => { failure ??= parserError(code === 'DOCUMENT_PARSE_TIMEOUT' ? 504 : 502, code); child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('DOCUMENT_PARSE_TIMEOUT'), this.timeoutMs);
      // Linux RSS includes buffers/native allocations outside V8's heap budget.
      const memory = process.platform === 'linux' ? setInterval(() => {
        if (child.pid) void readFile('/proc/' + child.pid + '/status', 'utf8').then(status => {
          const kb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
          if (kb > 256 * 1024) stop('EXTRACTION_LIMIT');
        }).catch(() => {});
      }, 100) : undefined;
      const abort = () => stop('DOCUMENT_PARSE_TIMEOUT');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) stop('EXTRACTION_LIMIT'); else chunks.push(chunk); });
      child.stderr.on('data', () => {}); // drain without exposing raw document data or paths
      child.stdin.on('error', () => {});
      child.on('error', () => { failure = parserError(503, 'DOCUMENT_PARSER_UNAVAILABLE'); });
      child.on('close', code => {
        clearTimeout(timer); clearInterval(memory); signal?.removeEventListener('abort', abort); this.child = undefined;
        if (failure) return reject(failure);
        if (code !== 0 || this.stopped) return reject(parserError(502, 'DOCUMENT_PARSE_FAILED'));
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const failureCode = z.object({ ok: z.literal(false), code: z.enum(['ATTACHMENT_SIZE_LIMIT', 'UNSUPPORTED_ATTACHMENT_FORMAT',
            'NO_EXTRACTABLE_TEXT', 'PAGE_PROVENANCE_UNAVAILABLE', 'EXTRACTION_LIMIT', 'PARSER_VERSION_MISMATCH', 'DOCUMENT_PARSE_FAILED', 'PROTECTED_DOCUMENT']) }).safeParse(payload);
          if (failureCode.success) return reject(parserError(422, failureCode.data.code));
          const parsed = ParsedDocument.parse(payload);
          let previous = 0;
          for (const [i, unit] of parsed.units.entries()) {
            if (unit.index !== i + 1 || unit.start !== previous || unit.end < unit.start || unit.end > parsed.text.length
              || (parsed.format === 'pdf' ? unit.page_number !== i + 1 : unit.page_number !== null)) throw Error('Invalid boundaries');
            previous = unit.end + 2;
          }
          if (previous - 2 !== parsed.text.length || (parsed.format === 'pdf' && parsed.page_count !== parsed.units.length)) throw Error('Invalid text coverage');
          resolve(parsed);
        } catch { reject(parserError(502, 'INVALID_PARSER_RESPONSE')); }
      });
      child.stdin.end(bytes);
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  async close() { this.stopped = true; this.child?.kill('SIGKILL'); await this.running?.catch(() => {}); }
}

export function documentParserFromEnv(env: NodeJS.ProcessEnv = process.env): DocumentParser | undefined {
  if (env.DOCUMENT_PARSER_DISABLED === '1') return undefined;
  return new DocumentParser();
}
