import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const release = JSON.parse(await readFile('.runtime/taxlaw/active.json', 'utf8'));
const pin = JSON.parse(await readFile('upstreams/korean-taxlaw-mcp.json', 'utf8'));
const previous = JSON.parse(await readFile('upstreams/korean-taxlaw-mcp.tools.json', 'utf8'));
assert.equal(release.version, pin.version); assert.equal(release.commit, pin.commit);
const client = new Client({ name: 'provider-schema-snapshot', version: '1' });
const transport = new StdioClientTransport({ command: release.python, args: ['-I', '-m', 'korean_taxlaw_mcp'], cwd: release.cwd,
  env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DO_NOT_TRACK: '1' }, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
try {
  await client.connect(transport, { timeout: 20000 }); assert.equal(client.getServerVersion().version, pin.version);
  const result = await client.listTools({}, { timeout: 20000 }); assert.equal(result.nextCursor, undefined);
  assert.ok(result.tools.length > 0 && result.tools.length < 100);
  const names = result.tools.map(tool => tool.name); assert.equal(new Set(names).size, names.length);
  assert.ok(previous.every(tool => names.includes(tool.name)), 'EXISTING_TOOL_REMOVED');
  for (const tool of result.tools) { assert.match(tool.name, /^[a-z][a-z0-9_]*$/); assert.equal(tool.inputSchema.type, 'object'); }
  await writeFile('upstreams/korean-taxlaw-mcp.tools.json', JSON.stringify(result.tools.map(({ outputSchema, ...tool }) => tool), null, 2) + '\n');
} finally { await client.close(); }
