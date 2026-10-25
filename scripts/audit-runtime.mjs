import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const advisory = 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5';
const kordocNodes = ['node_modules/kordoc', 'node_modules/korean-law-mcp/node_modules/kordoc'];
const expectedNodes = {
  zod: kordocNodes.map(p => p + '/node_modules/zod'),
  kordoc: kordocNodes,
  'korean-law-mcp': ['node_modules/korean-law-mcp'],
};
const productionSeverity = new Set(['moderate', 'high', 'critical']);
const portable = path => path.split(sep).join('/');
const text = async path => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const packageName = spec => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

export function classifyAudit(report) {
  assert.equal(report.auditReportVersion, 2, 'AUDIT_FORMAT_CHANGED');
  assert.ok(!report.error && report.vulnerabilities && report.metadata?.vulnerabilities, 'AUDIT_UNAVAILABLE');
  const findings = Object.entries(report.vulnerabilities);
  assert.equal(report.metadata.vulnerabilities.total, findings.length, 'AUDIT_INCOMPLETE');
  const scoped = new Set();
  const zod = report.vulnerabilities.zod;
  if (zod && same(zod.nodes ?? [], expectedNodes.zod) && zod.via?.length > 0
      && zod.via.every(item => typeof item === 'object' && item.name === 'zod' && item.url === advisory)) {
    scoped.add('zod');
    for (const [name, via] of [['kordoc', 'zod'], ['korean-law-mcp', 'kordoc']]) {
      const item = report.vulnerabilities[name];
      if (scoped.has(via) && item && same(item.nodes ?? [], expectedNodes[name])
          && same(item.via ?? [], [via])) scoped.add(name);
    }
  }
  const blocked = findings.filter(([name, item]) => {
    assert.ok(['info', 'low', 'moderate', 'high', 'critical'].includes(item.severity), 'AUDIT_SEVERITY_CHANGED');
    return productionSeverity.has(item.severity) && !scoped.has(name);
  }).map(([name]) => name);
  return { blocked, scoped: [...scoped], total_findings: findings.length };
}

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (/\.[cm]?[jt]s$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) result.push(path);
  }
  return result;
}

export async function verifyParseBoundary(root, manifest) {
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.advisory, 'GHSA-mrhx-c7xc-m3w5');
  assert.equal(manifest.legacy_zod_version, '3.25.76');
  assert.ok(same(manifest.packages.map(p => p.path), kordocNodes), 'PARSER_SCOPE_CHANGED');
  const lock = JSON.parse(await readFile(join(root, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/zod'].version, '4.6.7', 'ROOT_VALIDATOR_CHANGED');
  assert.ok(same(Object.entries(lock.packages).filter(([p, item]) => /\/zod$/.test(p) && item.version.startsWith('3.'))
    .map(([p]) => p), expectedNodes.zod), 'LEGACY_VALIDATOR_SCOPE_CHANGED');
  const insideLegacy = path => kordocNodes.some(p => portable(relative(root, path)).startsWith(p + '/'));
  const checksums = { ...manifest.consumers };
  for (const pkg of manifest.packages) {
    assert.equal(lock.packages[pkg.path]?.version, pkg.version, 'PARSER_VERSION_CHANGED');
    assert.equal(lock.packages[pkg.path + '/node_modules/zod']?.version, manifest.legacy_zod_version, 'LEGACY_VERSION_CHANGED');
    const installed = JSON.parse(await readFile(join(root, pkg.path, 'package.json'), 'utf8'));
    assert.equal(installed.version, pkg.version, 'PARSER_INSTALL_CHANGED');
    assert.equal(installed.exports['.'].import, './dist/index.js', 'PARSER_ENTRY_CHANGED');
    assert.equal(JSON.parse(await readFile(join(root, pkg.path, 'node_modules/zod/package.json'), 'utf8')).version,
      manifest.legacy_zod_version, 'LEGACY_INSTALL_CHANGED');
    Object.assign(checksums, pkg.files);
    const require = createRequire(join(root, pkg.path, 'dist/index.js'));
    const required = new Set(['@xmldom/xmldom', 'cfb', 'jszip', 'markdown-it', 'pdfjs-dist']);
    for (const spec of pkg.externals) {
      if (isBuiltin(spec)) continue;
      // OCR/browser extras are deliberately absent from the locked --omit=optional install.
      let target;
      try { target = require.resolve(spec); }
      catch (error) {
        assert.ok(!required.has(packageName(spec)) && error.code === 'MODULE_NOT_FOUND', 'PARSER_EXTERNAL_MISSING');
        continue;
      }
      assert.ok(required.has(packageName(spec)), 'UNREVIEWED_PARSER_EXTRA_INSTALLED');
      assert.ok(!insideLegacy(target), 'PARSER_EXTERNAL_RESOLUTION_CHANGED');
    }
  }
  for (const [path, hash] of Object.entries(checksums)) {
    assert.ok(!isAbsolute(path) && !path.split('/').includes('..'), 'BOUNDARY_PATH_INVALID');
    const actual = createHash('sha256').update(await text(join(root, path))).digest('hex');
    assert.equal(actual, hash, 'PARSER_BOUNDARY_CHANGED: ' + path);
  }
  const consumers = [];
  for (const file of [...await filesUnder(join(root, 'src')), ...await filesUnder(join(root, 'node_modules/korean-law-mcp/build'))]) {
    const source = await text(file);
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    let usesKordoc = false;
    const specifier = node => {
      assert.ok(node && ts.isStringLiteralLike(node), 'UNREVIEWED_COMPUTED_IMPORT');
      if (node.text === 'kordoc' || node.text.startsWith('kordoc/')) usesKordoc = true;
      assert.ok(node.text !== 'zod/v3', 'LEGACY_VALIDATOR_IMPORT');
    };
    const walk = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier(node.moduleSpecifier);
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')
            || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && ts.isMetaProperty(callee.expression))) {
          specifier(node.arguments[0]);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
    if (usesKordoc) consumers.push(portable(relative(root, file)));
  }
  assert.ok(same(consumers, Object.keys(manifest.consumers)), 'PARSER_CONSUMER_CHANGED: ' + consumers.join(', '));
  return { advisory: manifest.advisory, nodes: expectedNodes.zod, reason: manifest.reason };
}

export async function runtimeAudit(root, report) {
  const result = classifyAudit(report);
  assert.equal(result.blocked.length, 0, 'RUNTIME_VULNERABILITIES: ' + result.blocked.join(', '));
  if (result.scoped.length) {
    const manifest = JSON.parse(await readFile(join(root, 'upstreams/kordoc-parse-audit.json'), 'utf8'));
    result.exception = await verifyParseBoundary(root, manifest);
  }
  return { status: 'pass', ...result };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.ok(process.env.npm_execpath, 'Use npm run audit:runtime');
    let output;
    try {
      output = execFileSync(process.execPath, [process.env.npm_execpath, 'audit', '--omit=dev', '--omit=optional', '--json'],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      // npm's nonzero exit also represents reported advisories; malformed/network results still fail below.
      assert.ok(error.status === 1 && typeof error.stdout === 'string', 'AUDIT_EXECUTION_FAILED');
      output = error.stdout;
    }
    console.log(JSON.stringify(await runtimeAudit(process.cwd(), JSON.parse(output))));
  } catch (error) {
    console.error('RUNTIME_AUDIT_FAILED: ' + error.message);
    process.exitCode = 1;
  }
}
