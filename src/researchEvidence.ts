import { digest } from './contracts.js';

export type BodyScope = 'body_returned' | 'discovery_only' | 'partial' | 'unknown';
export interface Passage {
  passage_id: string; unit_id: string; role: string; field: string; text: string; hash: string;
  body_scope: BodyScope; start: number; end: number;
}
export interface EvidenceUnit {
  unit_id: string; role: string; date: string | null; source_access: 'available' | 'unavailable';
  body_scope: BodyScope; document_id: string; document_version: string; error_code?: string;
}
export interface AdaptedEvidence {
  upstream_name: string; upstream_version: string; upstream_commit: string | null; response_hash: string; body_scope: BodyScope;
  document_id: string; document_version: string; source_url: string | null;
  source_kind: 'provider_formatted_text'; completeness: 'unverified'; units: EvidenceUnit[]; passages: Passage[];
  outcome: 'completed' | 'empty' | 'failed'; error_code?: string;
}
export interface ResearchEvidence extends AdaptedEvidence {
  evidence_id: string; revision: number; issue_ids: string[]; purpose: 'support' | 'counter' | 'context' | 'timing';
  tool: string; arguments_hash: string; observed_at: string; expires_at: string;
}
export interface ResearchAttempt {
  attempt_id: string; revision: number; issue_ids: string[]; purpose: ResearchEvidence['purpose']; tool: string;
  arguments_hash: string; status: 'pending' | 'completed' | 'failed' | 'empty'; error_code?: string; evidence_id?: string;
}
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {};
const label = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1024 ? v : 'unknown';
const bodyFields = ['facts', 'question', 'answer', 'reasoning', 'conclusion', 'claimantView', 'agencyView', 'relatedLawsText'];
const bodyTools = new Set(['lookup_tax_document', 'get_tax_document', 'lookup_local_tax_document']);
const discoveryTools = new Set(['search_law', 'search_decisions', 'legal_research', 'search_tax_interpretations', 'search_tax_decisions',
  'search_tax_guidance', 'get_tax_guidance', 'search_tax_forms', 'search_taxlaw', 'tax_research', 'search_local_tax_interpretations', 'search_local_tax_decisions']);
export const researchSourceTools = new Set([...bodyTools, ...discoveryTools, 'get_law_text', 'get_decision_text', 'check_legal_sources']);
const shortened = (v: string) => /나머지는 sourceUrl 원문에서 확인하세요|응답 크기 제한|자로 (?:잘렸|축약)|📋 요약 모드|이 섹션 .*축약/.test(v);
const textBlocks = (result: RecordValue): string[] => Array.isArray(result.content)
  ? result.content.map(record).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text as string) : [];

/** Only known fields are body candidates. No recursive string search, URLs or client-uploaded receipts. */
export function adaptResearchEvidence(tool: string, args: RecordValue, response: unknown): AdaptedEvidence {
  const wrapper = record(response), server = record(wrapper.server), result = record(wrapper.result);
  const adapted: AdaptedEvidence = { upstream_name: label(server.name), upstream_version: label(server.version),
    upstream_commit: typeof record(record(result._meta)['legal-harness/taxlaw']).commit === 'string'
      && /^[a-f0-9]{40}$/.test(String(record(record(result._meta)['legal-harness/taxlaw']).commit))
      ? String(record(record(result._meta)['legal-harness/taxlaw']).commit) : null,
    response_hash: digest(tool === 'check_legal_sources' ? { ...wrapper, previous: undefined } : result),
    body_scope: 'unknown', document_id: 'unknown', document_version: 'unknown', source_url: null,
    source_kind: 'provider_formatted_text', completeness: 'unverified', units: [], passages: [], outcome: 'completed' };
  const add = (unit: EvidenceUnit, field: string, text: string, start = 0, end = text.length) => {
    if (!text.slice(start, end).trim()) return;
    const value = text.slice(start, end);
    adapted.passages.push({ passage_id: 'p' + (adapted.passages.length + 1), unit_id: unit.unit_id, role: unit.role,
      field, text: value, hash: digest(value), body_scope: unit.body_scope, start, end });
  };
  const unit = (role: string, date: string | null, document_id: string, document_version: string, scope: BodyScope): EvidenceUnit => {
    const value: EvidenceUnit = { unit_id: 'u' + (adapted.units.length + 1), role, date, source_access: 'available', body_scope: scope, document_id, document_version };
    adapted.units.push(value); return value;
  };
  const law = (raw: RecordValue, role: string, date: string | null, lawArgs: RecordValue) => {
    const texts = textBlocks(raw), joined = texts.join('\n');
    const version = label(/^시행일:\s*(\d{8})\s*$/m.exec(joined)?.[1]);
    const u = unit(role, date, label(lawArgs.mst ?? lawArgs.lawId), version, 'unknown');
    if (raw.isError === true) { u.source_access = 'unavailable'; u.error_code = 'MCP_TOOL_ERROR'; return; }
    if (/목차\s*\(총\s*\d+개 조문\)/.test(joined)) {
      u.body_scope = 'discovery_only'; texts.forEach((text, i) => add(u, `content[${i}].text`, text)); return;
    }
    if (!/^법령명:\s*\S/m.test(joined)) return;
    u.body_scope = shortened(joined) ? 'partial' : 'body_returned';
    const before = adapted.passages.length;
    texts.forEach((text, i) => {
      const headings = [...text.matchAll(/^제\d+조(?:의\d+)?[^\r\n]*(?:\r?\n|$)/gm)];
      for (let n = 0; n < headings.length; n++) {
        const start = headings[n].index! + headings[n][0].length, end = headings[n + 1]?.index ?? text.length;
        // Heading-only records contain no body. Keep exact offsets in the provider's text.
        let a = start, b = end;
        while (a < b && /\s/.test(text[a])) a++;
        while (b > a && /\s/.test(text[b - 1])) b--;
        if (b > a) add(u, `content[${i}].text`, text, a, b);
      }
    });
    if (before === adapted.passages.length) u.body_scope = 'unknown';
  };
  if (tool === 'check_legal_sources') {
    adapted.upstream_name = 'korean-law-mcp'; adapted.upstream_version = label(wrapper.upstream_version);
    if (wrapper.source_access !== 'available') {
      adapted.outcome = 'failed'; adapted.error_code = 'SOURCE_REFRESH_FAILED'; return adapted;
    }
    law(record(wrapper.current_result), 'current', null, { lawId: args.law_id });
    adapted.source_url = label(record(wrapper.source).url) === 'unknown' ? null : label(record(wrapper.source).url);
    // Historical compound output includes provider inference. It is inspectable, never promoted to official body text.
    const observations = Array.isArray(wrapper.historical_observations) ? wrapper.historical_observations.slice(0, 12).map(record) : [];
    for (const observation of observations) {
      const u = unit(label(observation.role), label(observation.date), label(args.law_id), 'unknown', 'unknown');
      if (observation.source_access !== 'available') { u.source_access = 'unavailable'; u.error_code = 'SOURCE_REFRESH_FAILED'; }
      else textBlocks(record(observation.result)).forEach((text, i) => add(u, `historical.${u.role}.content[${i}].text`, text));
    }
  } else if (result.isError === true) {
    adapted.outcome = 'failed'; adapted.error_code = 'MCP_TOOL_ERROR';
  } else {
    const data = record(result.structuredContent), doc = record(data.document), meta = record(record(result._meta)['legal-harness/taxlaw']);
    if (bodyTools.has(tool) || (tool === 'get_decision_text' && args.domain === 'nts' && Object.keys(doc).length)) {
      const u = unit('document', null, label(doc.ntstDcmId ?? doc.documentNumber), label(doc.productionDate ?? doc.decisionDate), 'unknown');
      adapted.source_url = label(doc.sourceUrl) === 'unknown' ? null : label(doc.sourceUrl);
      if (doc.bodyUnavailable === true || meta.body_scope === 'unavailable') { adapted.outcome = 'failed'; adapted.error_code = 'DETAIL_NOT_AVAILABLE'; u.source_access = 'unavailable'; }
      else {
        const values = bodyFields.filter(key => typeof doc[key] === 'string' && (doc[key] as string).trim().length > 0);
        if (values.length) {
          u.body_scope = meta.body_scope === 'partial' || args.detail === 'compact' || args.include_full_text === false
            || values.some(key => shortened(doc[key] as string)) ? 'partial' : 'body_returned';
          for (const key of values) add(u, 'document.' + key, doc[key] as string);
        }
      }
    } else if (tool === 'get_law_text') law(result, 'document', null, args);
    else if (tool === 'get_decision_text') {
      const texts = textBlocks(result), u = unit('document', null, label(args.id), 'unknown', 'unknown');
      texts.forEach((text, i) => {
        const sections = [...text.matchAll(/^(?:【([^】]+)】|\[([^\]]+)\]|(?:■|▶)\s*([^\r\n]+))\s*\r?\n/gm)];
        for (let n = 0; n < sections.length; n++) {
          if (!/^(?:판시사항|판결요지|판결내용|판결전문|이유|주문|결정요지|회신|질의|사실관계)$/.test((sections[n][1] ?? sections[n][2] ?? sections[n][3]).trim())) continue;
          u.body_scope = args.full === true && !shortened(text) ? 'body_returned' : 'partial';
          add(u, `content[${i}].text`, text, sections[n].index! + sections[n][0].length, sections[n + 1]?.index ?? text.length);
        }
      });
    } else if (discoveryTools.has(tool)) {
      const u = unit('discovery', null, 'unknown', 'unknown', 'discovery_only');
      const texts = textBlocks(result);
      if (texts.length) texts.forEach((text, i) => add(u, `content[${i}].text`, text));
      else if (Object.keys(data).length) add(u, 'structuredContent', JSON.stringify(data));
      if (data.total === 0 || (Array.isArray(data.items) && data.items.length === 0)) adapted.outcome = 'empty';
    }
  }
  adapted.document_id = adapted.units[0]?.document_id ?? 'unknown';
  adapted.document_version = adapted.units[0]?.document_version ?? 'unknown';
  const scopes = adapted.units.map(u => u.body_scope);
  adapted.body_scope = scopes.includes('partial') ? 'partial' : scopes.includes('body_returned') ? 'body_returned'
    : scopes.length && scopes.every(s => s === 'discovery_only') ? 'discovery_only' : 'unknown';
  return adapted;
}

/** Cap the serialized receipt, not just string character counts (Korean UTF-8 is multi-byte). */
export function boundEvidence<T extends { passages: Passage[]; units: EvidenceUnit[]; body_scope: BodyScope }>(receipt: T, byteLimit: number): T {
  let cut = false;
  if (receipt.passages.length > 32) { receipt.passages = receipt.passages.slice(0, 32); cut = true; }
  const size = () => Buffer.byteLength(JSON.stringify(receipt));
  while (size() > byteLimit && receipt.passages.length) {
    cut = true;
    const last = receipt.passages.at(-1)!;
    if (last.text.length > 128) {
      const budget = Math.max(0, Buffer.byteLength(last.text) - (size() - byteLimit) - 256);
      let end = Math.min(last.text.length, budget);
      while (end > 0 && Buffer.byteLength(last.text.slice(0, end)) > budget) end = Math.floor(end * 0.8);
      if (end > 0 && /[\uD800-\uDBFF]/.test(last.text[end - 1])) end--;
      last.text = last.text.slice(0, end); last.end = last.start + end; last.hash = digest(last.text);
      if (!last.text.trim()) receipt.passages.pop();
    } else receipt.passages.pop();
  }
  if (cut) {
    receipt.body_scope = 'partial';
    for (const u of receipt.units) if (u.body_scope === 'body_returned') u.body_scope = 'partial';
    for (const p of receipt.passages) if (p.body_scope === 'body_returned') p.body_scope = 'partial';
  }
  return receipt;
}
