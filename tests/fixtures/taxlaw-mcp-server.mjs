import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';

const tools = JSON.parse(readFileSync(new URL('../../upstreams/korean-taxlaw-mcp.tools.json', import.meta.url), 'utf8'));
const server = new Server({ name: 'korean-taxlaw', version: '2.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments ?? {};
  const query = args.document_number ?? args.query ?? '';
  if (query === '__hang__') await new Promise(() => {});
  if (query === '__crash__') process.exit(7);
  const label = query === '__missing__' ? 'NOT_FOUND' : query === '__offline__' ? 'UPSTREAM_ERROR' : 'OK';
  const data = label === 'OK' ? { document: { documentNumber: query, ntstDcmId: args.ntst_dcm_id ?? '010000000000575140',
    facts: 'fixture facts', question: 'fixture question', answer: 'fixture answer',
    ...(query === '__body_missing__' ? { bodyUnavailable: true } : {}),
    sourceUrl: 'https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=010000000000575140' },
    fixture: { pid: process.pid, args, law_oc: Boolean(process.env.LAW_OC), secret: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) } }
    : { ok: false, error: { code: label, message: 'Fixture source result' }, guardrail: 'Do not invent a document.' };
  const text = `[${label}]\n${JSON.stringify(data)}`;
  return { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false };
});
await server.connect(new StdioServerTransport());
