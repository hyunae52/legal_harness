import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { KoreanLawClient, LawMcpError, type LawMcpOptions } from './koreanLawClient.js';

const pin = JSON.parse(readFileSync(new URL('../upstreams/korean-taxlaw-mcp.json', import.meta.url), 'utf8')) as { commit: string; version: string };
// These schemas were obtained from the pinned server's real tools/list response.
// Discovery stays available when an optional provider is temporarily down.
export const taxLawTools: Tool[] = JSON.parse(readFileSync(new URL('../upstreams/korean-taxlaw-mcp.tools.json', import.meta.url), 'utf8'));
export const taxLawToolNames = new Set(taxLawTools.map(t => t.name));
const ReleaseSchema = z.object({
  version: z.literal(pin.version), commit: z.literal(pin.commit),
  python: z.string().refine(isAbsolute), cwd: z.string().refine(isAbsolute),
}).strict();

export function taxLawOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LawMcpOptions | undefined {
  const manifest = env.TAXLAW_MCP_RELEASE_FILE || fileURLToPath(new URL('../.runtime/taxlaw/active.json', import.meta.url));
  if (!existsSync(manifest)) {
    if (env.TAXLAW_MCP_RELEASE_FILE) throw new Error('Configured TAXLAW_MCP_RELEASE_FILE is missing.');
    return undefined;
  }
  const release = ReleaseSchema.parse(JSON.parse(readFileSync(manifest, 'utf8')));
  if (!existsSync(release.python) || !existsSync(release.cwd)) throw new Error('Tax-law MCP installation is missing.');
  const timeout = z.coerce.number().int().min(100).max(45_000);
  return {
    server: {
      command: release.python, args: ['-I', '-X', 'utf8', '-m', 'korean_taxlaw_mcp'], cwd: release.cwd,
      // Never forward Express credentials, proxy configuration, or Python path injection.
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', FASTMCP_LOG_LEVEL: 'WARNING', DO_NOT_TRACK: '1',
        TAXLAW_TIMEOUT_MS: '12000', TAXLAW_RETRIES: '1', TAXLAW_RATE_PER_MIN: '60', TAXLAW_RATE_BURST: '5',
        TAXLAW_BODY_LIMIT: '30000', TAXLAW_CACHE_MAX: '64' },
    },
    connectTimeoutMs: timeout.parse(env.TAXLAW_MCP_CONNECT_TIMEOUT_MS || 15_000),
    requestTimeoutMs: timeout.parse(env.TAXLAW_MCP_TIMEOUT_MS || 45_000),
    maxConcurrentCalls: 2, releaseVersion: release.version,
    credentialPolicy: 'none', providerName: 'korean-taxlaw-mcp',
  };
}

const errorStatus: Record<string, number> = {
  NOT_FOUND: 404, DETAIL_NOT_AVAILABLE: 502, UPSTREAM_ERROR: 502, PARSE_ERROR: 502,
  RATE_LIMITED: 429, INVALID_INPUT: 400, TIMEOUT: 504,
};
function malformed(): never {
  throw new LawMcpError(502, 'TAXLAW_INVALID_RESPONSE', 'Tax-law MCP returned an unrecognized response.');
}

/** Upstream returns [ERROR_CODE] as a successful MCP string: promote it to a real failure. */
export function normalizeTaxLawResult(result: CallToolResult): CallToolResult {
  const structured = result.structuredContent;
  const raw = typeof structured?.result === 'string' ? structured.result
    : result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (raw.length > 2_000_000) return malformed();
  const match = /^\[([A-Z_]+)\]\r?\n([\s\S]+)$/.exec(raw);
  if (!match) return malformed();
  const label = match[1];
  let payload: Record<string, unknown>;
  try { payload = z.record(z.unknown()).parse(JSON.parse(match[2])); } catch { return malformed(); }
  if (label !== 'OK') {
    const error = z.object({ code: z.string(), message: z.string() }).passthrough().safeParse(payload.error);
    if (!errorStatus[label] || payload.ok !== false || !error.success || error.data.code !== label) return malformed();
    const normalized = { ...result, isError: true, structuredContent: payload,
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    throw new LawMcpError(errorStatus[label], 'MCP_TOOL_ERROR', 'Tax-law source retrieval failed.', normalized);
  }
  if (result.isError || payload.ok === false || payload.error) return malformed();
  return { ...result, isError: false, structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

type ManagedClient = Pick<KoreanLawClient, 'listTools' | 'callTool' | 'close' | 'releaseVersion'>;
export class TaxLawClient {
  readonly commit = pin.commit;
  constructor(private readonly client: ManagedClient) {}
  get releaseVersion() { return this.client.releaseVersion; }
  async listTools() { return { server: { name: 'korean-taxlaw', version: pin.version }, tools: taxLawTools }; }
  async callTool(name: string, args: Record<string, unknown>) {
    if (!taxLawToolNames.has(name)) throw new LawMcpError(400, 'MCP_UNKNOWN_TOOL', 'Unknown tax-law tool.');
    const response = await this.client.callTool(name, args);
    const result = normalizeTaxLawResult(response.result);
    const document = z.record(z.unknown()).safeParse(result.structuredContent?.document);
    // lookup_tax_document does not promote get_document's bodyUnavailable marker.
    // Do not let a found metadata record masquerade as a successful body read.
    if (document.success && document.data.bodyUnavailable === true && args.include_full_text !== false
      && ['lookup_tax_document', 'get_tax_document'].includes(name)) {
      const failure = { ok: false, error: { code: 'DETAIL_NOT_AVAILABLE',
        message: '문서는 찾았으나 국세청 본문을 확보하지 못했습니다.', detail: { document: document.data } },
        guardrail: '메타데이터와 원문 링크만 확인된 상태입니다. 본문 내용을 추측하지 마세요.' };
      throw new LawMcpError(502, 'MCP_TOOL_ERROR', 'NTS document body unavailable.', {
        isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure,
      });
    }
    const truncated = document.success ? Object.entries(document.data)
      .filter(([, value]) => typeof value === 'string' && value.includes('나머지는 sourceUrl 원문에서 확인하세요.'))
      .map(([key]) => key) : [];
    return { ...response, result: { ...result, _meta: { ...result._meta, 'legal-harness/taxlaw': {
      commit: this.commit, truncated_fields: truncated,
      body_scope: document.success ? (document.data.bodyUnavailable ? 'unavailable'
        : args.detail === 'compact' || args.include_full_text === false || truncated.length ? 'partial' : 'provided') : 'not_assessed',
      completeness: 'unverified',
    } } } };
  }
  close() { return this.client.close(); }
}

export class LegalRetrievalClient {
  constructor(private readonly law: ManagedClient, private readonly taxlaw?: TaxLawClient) {}
  get releaseVersion() { return this.law.releaseVersion; }
  get taxlawRelease() { return this.taxlaw ? { version: this.taxlaw.releaseVersion, commit: this.taxlaw.commit } : null; }
  async listTools() {
    const base = await this.law.listTools();
    return { ...base, tools: [...base.tools, ...(this.taxlaw ? taxLawTools : [])] };
  }
  async callTool(name: string, args: Record<string, unknown>) {
    if (taxLawToolNames.has(name)) {
      if (!this.taxlaw) throw new LawMcpError(503, 'TAXLAW_NOT_CONFIGURED', 'Install the pinned tax-law provider first.');
      return this.taxlaw.callTool(name, args);
    }
    if (name === 'get_decision_text' && args.domain === 'nts' && this.taxlaw) {
      if (typeof args.id !== 'string' || !/^\d{18}$/.test(args.id)) {
        throw new LawMcpError(400, 'MCP_TOOL_ERROR', 'A native NTS document identifier is required.', {
          isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'NTS_ID_REQUIRED',
            message: '법제처 일련번호는 국세청 문서 ID와 다릅니다. 문서번호로 lookup_tax_document를 호출하거나 search_tax_interpretations 결과의 ntstDcmId로 get_tax_document를 호출하세요.' }) }],
        });
      }
      return this.taxlaw.callTool('get_tax_document', { ntst_dcm_id: args.id, include_full_text: true, detail: 'full' });
    }
    return this.law.callTool(name, args);
  }
  async close() { await Promise.allSettled([this.law.close(), this.taxlaw?.close()]); }
}

export function createLegalRetrievalClient(law: ManagedClient, env: NodeJS.ProcessEnv = process.env) {
  const options = taxLawOptionsFromEnv(env);
  return new LegalRetrievalClient(law, options ? new TaxLawClient(new KoreanLawClient(options)) : undefined);
}
