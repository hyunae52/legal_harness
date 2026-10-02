/** Provider fields and document headers only. A quotation mentioning a court is not an issuer. */
export type AuthorityKind = 'supreme_court' | 'lower_court' | 'constitutional_court' | 'tax_appeal' | 'administrative_interpretation' | 'other';
export interface SourceIdentity {
  namespace: string; family: string; document_id: string; document_number: string | null;
  kind: AuthorityKind | 'unknown'; status: 'observed' | 'unknown' | 'conflict';
  agency: string | null; date: string | null;
  observations: { field: string; value: string; location: string }[];
}
export const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const short = (v: unknown, max = 300): string | null => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
export const contents = (result: Record<string, unknown>): string => Array.isArray(result.content)
  ? result.content.map(object).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';
export const documentKey = (i: Pick<SourceIdentity, 'namespace' | 'family' | 'document_id'>) => i.document_id !== 'unknown'
  ? `${i.namespace}:${i.family}:${i.document_id}` : null;
export function identityFromDocument(doc: Record<string, unknown>, namespace: string, family: string): SourceIdentity {
  const agencies = [...new Set([short(doc.issuingAgency), short(doc.court)].filter((s): s is string => Boolean(s)))];
  const agency = agencies[0] ?? null, number = short(doc.documentNumber ?? doc.caseNumber);
  const type = short(doc.documentType), level = short(doc.authorityLevel), kinds = new Set<SourceIdentity['kind']>();
  // Cross-check independent type and issuer observations; do not trust authorityLevel alone.
  for (const issuer of agencies) {
    if (issuer === '대법원' || issuer === 'Supreme Court') kinds.add('supreme_court');
    else if (/(?:지방|고등|가정|행정|특허)법원/.test(issuer)) kinds.add('lower_court');
    else if (issuer === '헌법재판소') kinds.add('constitutional_court');
    else if (/^(?:국세청|기획재정부|행정안전부|법제처)/.test(issuer) && type && /질의회신|사전답변|과세기준자문|유권해석|서면질의|예규|해석/.test(type)) kinds.add('administrative_interpretation');
  }
  if (short(doc.documentNumber) && short(doc.caseNumber) && short(doc.documentNumber) !== short(doc.caseNumber)) kinds.add('unknown');
  if (type && /심판|심사|이의신청|과세적부|감사원/.test(type)) kinds.add('tax_appeal');
  if (type && /질의회신|사전답변|과세기준자문|유권해석|예규/.test(type)) kinds.add('administrative_interpretation');
  if (level === 'nts_ruling' || level === 'local_ruling') {
    if (type && /질의회신|사전답변|유권해석|예규|해석/.test(type)) kinds.add('administrative_interpretation');
    if ([...kinds].some(k => k === 'supreme_court' || k === 'lower_court')) kinds.add('administrative_interpretation');
  }
  if (level === 'court_case' && kinds.has('administrative_interpretation')) kinds.add('unknown');
  const observations = ['documentType', 'authorityLevel', 'issuingAgency', 'court', 'documentNumber', 'caseNumber', 'productionDate', 'decisionDate']
    .flatMap(field => short(doc[field]) ? [{ field, value: short(doc[field])!, location: 'document.' + field }] : []);
  return { namespace, family, document_id: short(doc.ntstDcmId ?? doc.id) ?? 'unknown', document_number: number,
    kind: kinds.size === 1 ? [...kinds][0] : 'unknown', status: kinds.size > 1 ? 'conflict' : kinds.size ? 'observed' : 'unknown',
    agency, date: short(doc.productionDate ?? doc.decisionDate ?? doc.date), observations };
}
export function observeIdentity(tool: string, args: Record<string, unknown>, result: Record<string, unknown>): SourceIdentity {
  const data = object(result.structuredContent), doc = object(data.document), text = contents(result);
  if (Object.keys(doc).length) {
    const local = tool.includes('local_tax');
    const i = identityFromDocument(doc, local ? 'olta' : 'nts', local ? 'local_tax' : 'tax_document');
    if (i.document_id === 'unknown' && local) i.document_id = i.document_number ?? 'unknown';
    return i;
  }
  const isLaw = tool === 'get_law_text', domain = short(args.domain) ?? 'unknown';
  // Match only the provider's basic-information header, before any substantive body.
  const header = text.split(/\n(?:판시사항|판결요지|참조조문|전문|이유|주문|결정요지|회신|질의|사실관계):/)[0].slice(0, 4000);
  const value = (label: string) => short(new RegExp('^\\s*' + label + ':\\s*([^\\r\\n]+)', 'm').exec(header)?.[1]);
  const i = identityFromDocument({ id: short(args.id ?? args.mst ?? args.lawId), court: value('법원'), caseNumber: value('사건번호'), decisionDate: value('선고일') },
    'moleg', isLaw ? 'statute' : domain);
  i.observations = i.observations.map(o => ({ ...o, location: 'provider_header.' + o.field }));
  if (isLaw) { i.kind = 'other'; i.status = /^법령명:\s*\S/m.test(text) ? 'observed' : 'unknown'; }
  if (domain === 'tax_tribunal' && /^\s*(?:사건번호|청구번호):\s*\S/m.test(header)) { i.kind = 'tax_appeal'; i.status = 'observed'; }
  return i;
}
