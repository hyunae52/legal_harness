// A real JSON-RPC stdio peer. It never calls any external network service.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

if (process.argv.includes('--hang-start')) {
  setInterval(() => {}, 1000);
} else {
  const server = new Server({ name: 'law-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  let lists = 0;
  let calls = 0;
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    lists++;
    const names = request.params?.cursor === 'second' ? ['search_law'] : ['legal_research', 'get_law_text'];
    return {
      tools: names.map(name => ({ name, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } })),
      ...(request.params?.cursor ? {} : { nextCursor: 'second' }),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const callNumber = ++calls;
    const args = request.params.arguments ?? {};
    if (args.query === '__crash__') process.exit(12);
    if (args.query === '__hang__') return new Promise(() => {});
    if (args.query === '__invalid__') throw new McpError(ErrorCode.InvalidParams, 'Fixture invalid args');
    if (args.query === '__error__') return { isError: true, content: [{ type: 'text', text: 'Fixture upstream failure' }] };
    if (args.query === '__slow__') await new Promise(resolve => setTimeout(resolve, 250));
    return {
      content: [{ type: 'text', text: '법령 조회 fixture' }, {
        type: 'resource_link', name: '소득세법 fixture', uri: 'https://www.law.go.kr/법령/소득세법',
      }],
      structuredContent: {
        pid: process.pid, lists, callNumber, args,
        effectiveDate: '20250101',
        inheritedSecrets: Boolean(process.env.SUPABASE_ANON_KEY || process.env.GITHUB_TOKEN || process.env.NODE_OPTIONS),
        hasLawKey: Boolean(process.env.LAW_OC),
      },
      _meta: { fixture: true },
    };
  });
  await server.connect(new StdioServerTransport());
}
