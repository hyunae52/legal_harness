// Run: node --test tests/review-regressions.test.mjs
// Executes the current Express route code. Supabase HTTP, judge and GitHub
// dependencies are isolated: no credentials, paid API calls or remote writes.
// This is a backend regression gate, not validation of legal conclusions.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import express from 'express';
import * as yaml from 'js-yaml';
import ts from 'typescript';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { LawMcpError } from '../dist/koreanLawClient.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const token = 'review-user-token';
const userId = '00000000-0000-4000-8000-000000000001';
const evolveBody = {
  issue_summary: 'Review fixture',
  proposed_fail_if: 'Review fixture with no legal assertion',
  correction_prompt: 'Review fixture correction',
};

async function fixture(t, options = {}) {
  let app;
  const upstream = [];
  const mcpCalls = [];
  const clients = [];
  const reviewExpress = (...args) => {
    app = express(...args);
    // Suppress the entrypoint's production listen call. Bind only loopback below.
    app.listen = () => undefined;
    return app;
  };
  Object.assign(reviewExpress, express);

  const fakeFetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://review.invalid');
    upstream.push({
      path: url.pathname,
      authorization: request.headers.get('authorization'),
    });
    if (url.pathname === '/auth/v1/user') {
      assert.equal(request.headers.get('authorization'), 'Bearer ' + token);
      return Response.json({
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        created_at: '2024-01-01T00:00:00Z',
      });
    }
    if (url.pathname === '/rest/v1/evolution_logs') {
      return options.dbError
        ? Response.json({ code: '42501', message: 'Review insert denied' }, { status: 403 })
        : Response.json([], { status: 201 });
    }
    throw new Error('Unexpected upstream request: ' + url.pathname);
  };
  const dependencies = {
    express: reviewExpress,
    'js-yaml': yaml,
    zod: { z },
    dotenv: { config: () => ({}) },
    './supremeJudge.js': {
      verifyWithSupremeJudge: options.judge ?? (async () => true),
    },
    './gitOps.js': {
      createAutoPR: async () => 'https://example.invalid/review/pull/1',
    },
    './koreanLawClient.js': {
      LawMcpError,
      createKoreanLawClient: () => ({
        releaseVersion: options.releaseVersion,
        listTools: async () => ({ server: { name: 'fixture', version: '1' }, tools: [{ name: 'search_law' }] }),
        callTool: async (name, args) => {
          mcpCalls.push({ name, args });
          if (options.mcpError) throw options.mcpError;
          return { kind: 'retrieval', tool: name, result: { content: [{ type: 'text', text: 'Actual MCP fixture context' }] } };
        },
        close: async () => {},
      }),
    },
    '@supabase/supabase-js': {
      createClient: (url, key, clientOptions = {}) => {
        const client = createClient(url, key, {
          ...clientOptions,
          auth: {
            ...clientOptions.auth,
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
          global: { ...clientOptions.global, fetch: fakeFetch },
        });
        clients.push(client);
        return client;
      },
    },
    fs: {
      ...fs,
      readFileSync: (file, ...args) => {
        if (options.missingGates && path.basename(String(file)) === 'fail-cases.yaml') {
          throw Object.assign(new Error('Review fixture: no gates file'), { code: 'ENOENT' });
        }
        return fs.readFileSync(file, ...args);
      },
    },
    path,
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (id) => {
      if (!(id in dependencies)) throw new Error('Unmocked dependency: ' + id);
      return dependencies[id];
    },
    process: {
      env: {
        NODE_ENV: 'test',
        SUPABASE_URL: 'https://review.invalid',
        SUPABASE_ANON_KEY: 'review-anon-key',
      },
      cwd: () => root,
      once() {},
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  }, { filename: 'review-current-index.cjs' });

  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const client of clients) client.auth.stopAutoRefresh();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    upstream,
    mcpCalls,
    request: async (endpoint, body, authenticated = true) => {
      const response = await fetch(base + endpoint, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(authenticated ? { authorization: 'Bearer ' + token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('entrypoint external imports link in the production ESM module format', () => {
  // The route fixture uses CommonJS to inject dependencies. Check native ESM
  // separately so interop in that fixture cannot hide an invalid default import.
  // Only package import declarations execute: no entrypoint startup or .env load.
  const esm = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const ast = ts.createSourceFile('review-entry.mjs', esm, ts.ScriptTarget.ES2022);
  const imports = ast.statements.filter((statement) =>
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && !statement.moduleSpecifier.text.startsWith('.')
  ).map((statement) => statement.getText(ast)).join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', imports], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('unauthenticated analyze is rejected before upstream work', async (t) => {
  const app = await fixture(t);
  const result = await app.request('/api/analyze', { query: 'review' }, false);
  assert.equal(result.status, 401);
  assert.equal(app.upstream.length, 0);
  assert.equal(app.mcpCalls.length, 0);
});

test('completed requests release a concurrency slot exactly once', async (t) => {
  const app = await fixture(t);
  await app.request('/api/analyze', { query: 'review' }, false);
  const health = await app.request('/health');
  assert.equal(health.body.active_requests, 0,
    'finish and close must not both decrement the same request');
});

test('missing required quality gates cannot produce analyze success', async (t) => {
  const app = await fixture(t, { missingGates: true });
  const result = await app.request('/api/analyze', { query: '부당행위' });
  assert.ok(result.status >= 400,
    'required gates are unavailable but the endpoint returned ' + result.status);
});

test('quality-gate correction comes from the matching rule, not the first YAML entry', async (t) => {
  const gates = yaml.load(fs.readFileSync(path.join(root, 'fail-cases.yaml'), 'utf8')).gates;
  const matchingGate = gates.find((gate) => gate.id === 'QG-TIME-03');
  assert.ok(matchingGate, 'the time-of-assessment rule must exist');
  const app = await fixture(t);
  const result = await app.request('/api/analyze', {
    query: '특수관계인 간 부당행위계산부인의 해당성 판단시점과 시가 평가기간을 모두 잔금일 기준으로 통일합니다.',
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.correction_prompt, matchingGate.correction_prompt,
    'a timing-rule violation must not return an unrelated divorce-cost correction');
});

test('evolution insert carries the verified user token to Supabase RLS', async (t) => {
  const app = await fixture(t);
  const result = await app.request('/api/evolve', evolveBody);
  assert.equal(result.status, 200);
  const authRequest = app.upstream.find((entry) => entry.path === '/auth/v1/user');
  const dbRequest = app.upstream.find((entry) => entry.path === '/rest/v1/evolution_logs');
  assert.equal(authRequest?.authorization, 'Bearer ' + token);
  assert.equal(dbRequest?.authorization, 'Bearer ' + token,
    'getUser(token) alone does not set the database authorization context');
});

test('a returned database error cannot be reported as evolve success', async (t) => {
  const app = await fixture(t, { dbError: true });
  const result = await app.request('/api/evolve', evolveBody);
  assert.equal(result.status, 500);
  assert.notEqual(result.body.status, 'success');
});

test('evolution work also respects the configured concurrency capacity', async (t) => {
  const release = Promise.withResolvers();
  const overloaded = Promise.withResolvers();
  let entered = 0;
  const app = await fixture(t, {
    judge: async () => {
      entered++;
      if (entered > 3) overloaded.resolve('over-capacity');
      await release.promise;
      return true;
    },
  });
  const requests = Array.from({ length: 4 }, () => app.request('/api/evolve', evolveBody));
  const rejected = requests.map((request) => request.then((result) => {
    assert.equal(result.status, 429);
    return 'limited';
  }));
  try {
    const result = await Promise.race([overloaded.promise, ...rejected]);
    assert.equal(result, 'limited', 'all four evolution jobs entered the judge');
  } finally {
    release.resolve();
    // All requests must finish before closing their HTTP server, including
    // promises created only to detect an early 429 response.
    await Promise.allSettled([...requests, ...rejected]);
  }
});

test('analyze rejects an absent query instead of fabricating a successful answer', async (t) => {
  const app = await fixture(t);
  const result = await app.request('/api/analyze', {});
  assert.equal(result.status, 400,
    'an absent query must not become a successful "Draft answer for undefined"');
});

test('analyze returns upstream content and defaults to natural-language legal research', async (t) => {
  const app = await fixture(t);
  const result = await app.request('/api/analyze', { query: '소득세법' });
  assert.equal(result.status, 200);
  assert.equal(app.mcpCalls[0].name, 'legal_research');
  assert.equal(app.mcpCalls[0].args.query, '소득세법');
  assert.equal(result.body.data.result.content[0].text, 'Actual MCP fixture context');
  assert.equal(result.body.data.kind, 'retrieval');
  assert.equal(result.body.data.answer, undefined);
});

test('caller can select a text retrieval tool and retain upstream identifiers', async (t) => {
  const app = await fixture(t);
  const result = await app.request('/api/analyze', {
    query: '소득세법 제88조', tool: 'get_law_text', arguments: { mst: '123456', jo: '제88조' },
  });
  assert.equal(result.status, 200);
  assert.equal(app.mcpCalls[0].name, 'get_law_text');
  assert.deepEqual({ ...app.mcpCalls[0].args }, { mst: '123456', jo: '제88조' });
});

test('tool catalog requires authentication and process settings cannot come from HTTP input', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/tools', undefined, false)).status, 401);
  assert.equal((await app.request('/api/tools')).body.data.tools[0].name, 'search_law');
  assert.equal((await app.request('/api/analyze', { query: '법령', command: 'other-program' })).status, 400);
  assert.equal(app.mcpCalls.length, 0);
});

test('upstream tool failure, missing credentials and timeout never become analyze success', async (t) => {
  for (const [status, code] of [[502, 'MCP_TOOL_ERROR'], [503, 'MCP_NOT_CONFIGURED'], [504, 'MCP_TIMEOUT']]) {
    const app = await fixture(t, { mcpError: new LawMcpError(status, code, 'Fixture error') });
    const result = await app.request('/api/analyze', { query: '소득세법' });
    assert.equal(result.status, status);
    assert.equal(result.body.code, code);
    assert.notEqual(result.body.status, 'success');
  }
});

test('explicit caller draft is evaluated before legal retrieval', async (t) => {
  const app = await fixture(t);
  const result = await app.request('/api/analyze', {
    query: '소득세법',
    draft_answer: '특수관계인 간 부당행위계산부인의 해당성 판단시점과 시가 평가기간을 모두 잔금일 기준으로 통일합니다.',
  });
  assert.equal(result.status, 400);
  assert.equal(app.mcpCalls.length, 0);
});

test('health identifies the MCP release loaded by this Express process for deployment checks', async t => {
  const app = await fixture(t, { releaseVersion: '4.14.0' });
  const result = await app.request('/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.mcp_release, '4.14.0');
});
