import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DiscoverToolsSchema } from '../node_modules/korean-law-mcp/build/tools/meta-tools.js';
import { formatToolError } from '../node_modules/korean-law-mcp/build/lib/errors.js';
import { createApp } from '../dist/app.js';
import { LawMcpError } from '../dist/koreanLawClient.js';
import { safeToolDiagnostic } from '../dist/errorDiagnostics.js';

test('real provider validation guidance survives MCP and permits correcting the named argument', async t => {
  const runtime = createApp({ env: {}, authenticate: async () => ({ kind: 'auth_user', id: 'fixture' }), law: {
    releaseVersion: 'fixture', close: async () => {},
    listTools: async () => ({ tools: [{ name: 'discover_tools', inputSchema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] } }] }),
    callTool: async (name, args) => {
      const parsed = DiscoverToolsSchema.safeParse(args);
      if (!parsed.success) throw new LawMcpError(502, 'MCP_TOOL_ERROR', 'private exception', formatToolError(parsed.error, name));
      return { result: { content: [{ type: 'text', text: 'synthetic catalog' }] } };
    },
  } });
  const server = createServer(runtime.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'diagnostic-contract', version: '1' });
  t.after(async () => { await client.close(); await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const invalid = await client.callTool({ name: 'discover_tools', arguments: { query: 'synthetic intent' } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /^\[INVALID_PARAMETER\].*intent:/);
  assert.doesNotMatch(invalid.content[0].text, /OMITTED/);
  const valid = await client.callTool({ name: 'discover_tools', arguments: { intent: 'synthetic intent' } });
  assert.equal(valid.isError, undefined); assert.equal(valid.content[0].text, 'synthetic catalog');
});

test('known bracket labels preserve guidance while redacting credentials and traces', () => {
  const secret = 'synthetic-private-key';
  const text = '[INVALID_PARAMETER] intent: expected string\nhttps://source.invalid?OC=' + secret
    + '\nAuthorization: Bearer unknown-sensitive-value\n    at /private/internal.js:15';
  const result = safeToolDiagnostic({ isError: true, content: [{ type: 'text', text }] }, { LAW_OC: secret });
  assert.match(result.content[0].text, /^\[INVALID_PARAMETER\] intent: expected string/);
  for (const value of [secret, 'unknown-sensitive-value', '/private/internal.js']) assert.ok(!JSON.stringify(result).includes(value));
});

test('bracket labels do not bypass structured filtering, opaque-text rejection or bounds', () => {
  const secret = 'synthetic-json-key';
  const clean = text => safeToolDiagnostic({ isError: true, content: [{ type: 'text', text }] }, { LAW_OC: secret });
  const payload = JSON.stringify({ required: ['intent'], headers: { authorization: 'unknown-private-header' }, stack: 'internal-trace', detail: secret });
  const labelled = clean('[INVALID_PARAMETER] ' + payload).content[0].text;
  assert.match(labelled, /^\[INVALID_PARAMETER\] /);
  assert.deepEqual(JSON.parse(labelled.slice('[INVALID_PARAMETER] '.length)), { required: ['intent'], detail: '[REDACTED]' });
  for (const text of ['[INVALID_PARAMETER] mixed prose ' + payload, '[PRIVATE_UNKNOWN_LABEL] ' + payload]) {
    const result = JSON.stringify(clean(text));
    assert.ok(!result.includes('unknown-private-header')); assert.ok(!result.includes('internal-trace'));
    assert.ok(!result.includes(secret)); assert.match(result, /OMITTED/);
  }
  const long = clean('[EXTERNAL_API_ERROR] ' + 'x'.repeat(25000));
  assert.ok(Buffer.byteLength(JSON.stringify(long)) <= 16000);
});
