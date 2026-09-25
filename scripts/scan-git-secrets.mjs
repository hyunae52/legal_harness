#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const target = resolve(process.argv[2] ?? '.');
const maxBlobBytes = 10 * 1024 * 1024;

const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['google-oauth-secret', /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['alibaba-api-key', /\bsk-(?:sp|ws)-[A-Za-z0-9._-]{20,}\b/g],
  ['openai-api-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ['discord-token', /\b(?:mfa\.[A-Za-z0-9_-]{40,}|[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,})\b/g],
];

function git(args, options = {}) {
  return execFileSync('git', ['-C', target, ...args], {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isPlaceholder(match) {
  const value = match.toLowerCase();
  return value.includes('example') || value.includes('placeholder') || value.includes('redacted');
}

git(['rev-parse', '--is-inside-work-tree']);
const objectLines = git(['rev-list', '--objects', '--all'])
  .split(/\r?\n/u)
  .filter(Boolean);
const objectPaths = new Map();
for (const line of objectLines) {
  const separator = line.indexOf(' ');
  const oid = separator === -1 ? line : line.slice(0, separator);
  const path = separator === -1 ? '(unknown path)' : line.slice(separator + 1);
  if (!objectPaths.has(oid)) objectPaths.set(oid, path);
}

const batchInput = `${[...objectPaths.keys()].join('\n')}\n`;
const batchOutput = execFileSync('git', ['-C', target, 'cat-file', '--batch-check'], {
  input: batchInput,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

const findings = [];
let scannedBlobs = 0;
let skippedLargeBlobs = 0;
for (const line of batchOutput.split(/\r?\n/u).filter(Boolean)) {
  const [oid, type, sizeText] = line.split(' ');
  const size = Number(sizeText);
  if (type !== 'blob') continue;
  if (!Number.isFinite(size) || size > maxBlobBytes) {
    skippedLargeBlobs += 1;
    continue;
  }

  const content = git(['cat-file', 'blob', oid], { encoding: 'buffer' });
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  scannedBlobs += 1;
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (!isPlaceholder(match[0])) {
        findings.push({ kind, oid: oid.slice(0, 12), path: objectPaths.get(oid) });
      }
    }
  }
}

const unique = [...new Map(findings.map((finding) => [
  `${finding.kind}:${finding.oid}:${finding.path}`,
  finding,
])).values()];

console.log(JSON.stringify({
  repository: target,
  refs: git(['for-each-ref', '--format=%(refname)']).trim().split(/\r?\n/u).filter(Boolean).length,
  scannedBlobs,
  skippedLargeBlobs,
  findingCount: unique.length,
  findings: unique,
}, null, 2));

if (unique.length > 0) process.exitCode = 1;
