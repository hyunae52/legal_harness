// Explicit live check: the real pinned tax-law MCP -> official NTS attachment -> parser.
import assert from 'node:assert/strict';
import { createLegalRetrievalClient } from '../dist/taxLawClient.js';
const client = createLegalRetrievalClient({ listTools: async () => ({ tools: [] }),
  callTool: async () => { throw Error('Unexpected statute lookup'); }, close: async () => {} });
const documentNumber = process.argv[2] || '2024심사636';
try {
  const start = Date.now();
  let args = { document_number: documentNumber }, text = '', calls = 0, first;
  while (args) {
    assert.ok(calls < 50, 'Continuation bound exceeded');
    const response = await client.callTool('read_tax_attachment', args);
    const doc = response.result.structuredContent.document;
    first ??= doc;
    assert.equal(doc.attachment.sha256, first.attachment.sha256);
    assert.equal(doc.extraction.offset, text.length);
    text += doc.fullText; args = doc.extraction.next_arguments; calls++;
  }
  assert.equal(text.length, first.extraction.total_length);
  assert.ok(text.length > 100);
  console.log(JSON.stringify({ status: 'pass', document_number: documentNumber, taxlaw: client.taxlawRelease,
    parser: client.documentParserRelease, bytes: first.attachment.sizeBytes, file_sha256: first.attachment.sha256,
    pages: first.extraction.page_count, chars: text.length, calls, ms: Date.now() - start,
    extraction_warnings: first.extraction.warnings, completeness: 'unverified' }));
} finally { await client.close(); }
