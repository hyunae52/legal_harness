import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const productionSeverity = new Set(['moderate', 'high', 'critical']);

export function classifyAudit(report) {
  assert.equal(report.auditReportVersion, 2, 'AUDIT_FORMAT_CHANGED');
  assert.ok(!report.error && report.vulnerabilities && report.metadata?.vulnerabilities, 'AUDIT_UNAVAILABLE');
  const findings = Object.entries(report.vulnerabilities);
  assert.equal(report.metadata.vulnerabilities.total, findings.length, 'AUDIT_INCOMPLETE');
  const blocked = findings.filter(([, item]) => {
    assert.ok(['info', 'low', 'moderate', 'high', 'critical'].includes(item.severity), 'AUDIT_SEVERITY_CHANGED');
    return productionSeverity.has(item.severity);
  }).map(([name]) => name);
  return { blocked, total_findings: findings.length };
}

export function runtimeAudit(report) {
  const result = classifyAudit(report);
  assert.equal(result.blocked.length, 0, 'RUNTIME_VULNERABILITIES: ' + result.blocked.join(', '));
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
    console.log(JSON.stringify(runtimeAudit(JSON.parse(output))));
  } catch (error) {
    console.error('RUNTIME_AUDIT_FAILED: ' + error.message);
    process.exitCode = 1;
  }
}
