import 'dotenv/config';
import assert from 'node:assert/strict';
import { createKoreanLawClient } from '../dist/koreanLawClient.js';

// No API calls unless --live is explicitly supplied and LAW_OC is configured.
const client = createKoreanLawClient();
try {
  const catalog = await client.listTools();
  assert.equal(catalog.server?.name, 'korean-law', 'Unexpected MCP server');
  for (const name of ['legal_research', 'search_law', 'get_law_text', 'search_decisions', 'get_decision_text']) {
    assert.ok(catalog.tools.some(tool => tool.name === name && tool.inputSchema.type === 'object'), `Missing tool schema: ${name}`);
  }
  console.log(JSON.stringify({ server: catalog.server, tools: catalog.tools.map(tool => tool.name) }, null, 2));
  if (process.argv.includes('--live')) {
    const response = await client.callTool('search_law', { query: '소득세법', display: 1 });
    // Print only transport/result shape, not source bodies or API credentials.
    console.log(JSON.stringify({ live: true, tool: response.tool, retrieved_at: response.retrieved_at,
      content_types: response.result.content.map(item => item.type), isError: response.result.isError ?? false }));
  }
} finally {
  await client.close();
}
