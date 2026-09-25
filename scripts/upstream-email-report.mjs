import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import nodemailer from 'nodemailer';

const statuses = new Set(['current', 'updates_available', 'partial', 'check_failed']);
const email = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const clean = (value, fallback = '-') => {
  const text = String(value ?? '').replace(/[\r\n\0]+/g, ' ').trim();
  return text ? text.slice(0, 500) : fallback;
};

export async function loadEmailConfig(path) {
  if (!isAbsolute(path)) throw new Error('EMAIL_CONFIG_PATH_INVALID');
  const metadata = await stat(path);
  if (!emailConfigFileIsSecure(metadata)) {
    throw new Error('EMAIL_CONFIG_INSECURE');
  }
  const values = parseEnv(await readFile(path, 'utf8'));
  const config = {
    host: values.SMTP_HOST || 'smtp.gmail.com',
    port: Number(values.SMTP_PORT || 465),
    secure: (values.SMTP_SECURE || 'true') === 'true',
    user: values.SMTP_USER,
    pass: values.SMTP_APP_PASSWORD?.replace(/\s+/g, ''),
    to: values.ALERT_EMAIL_TO,
  };
  if (config.host !== 'smtp.gmail.com' || config.port !== 465 || !config.secure
      || !email.test(config.user || '') || !email.test(config.to || '')
      || !config.pass || config.pass.length > 128 || /[\r\n\0]/.test(config.pass)) {
    throw new Error('EMAIL_CONFIG_INVALID');
  }
  return config;
}

export function emailConfigFileIsSecure(metadata, platform = process.platform, effectiveUid = process.geteuid?.()) {
  if (!metadata.isFile() || metadata.size > 8192) return false;
  // Windows ACLs are not represented by POSIX mode bits. Production is Linux,
  // where group/world access and a mismatched owner are both rejected.
  if (platform === 'win32') return true;
  return (metadata.mode & 0o077) === 0 && (effectiveUid === undefined || metadata.uid === effectiveUid);
}

function koreanDate(iso) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function statusLabel(status, recovered) {
  if (recovered) return '복구';
  return {
    current: '정상',
    updates_available: '업데이트 발견',
    partial: '점검 일부 실패',
    check_failed: '점검 실패',
  }[status];
}

function candidateLine(candidate) {
  const value = candidate.version || candidate.commit?.slice(0, 12) || '변경 있음';
  return `- ${clean(candidate.provider)} / ${clean(candidate.kind)}: ${clean(value)}`;
}

export function prepareEmail(report, execution, previous = null) {
  if (!statuses.has(execution?.status) || !execution?.checked_at) throw new Error('EMAIL_REPORT_INVALID');
  const recovered = execution.status === 'current' && ['partial', 'check_failed'].includes(previous?.status);
  const label = statusLabel(execution.status, recovered);
  const installed = report?.installed;
  const candidates = Array.isArray(report?.candidates) ? report.candidates.slice(0, 20) : [];
  const sources = report?.sources && typeof report.sources === 'object' ? Object.entries(report.sources).slice(0, 20) : [];
  const lines = [
    'TaxLab MCP 자동 점검 결과',
    '',
    `상태: ${label}`,
    `점검 시각: ${koreanDate(execution.checked_at)} (한국시간)`,
    '',
    '운영 중인 버전',
    `- korean-law-mcp: ${clean(installed?.law?.version)}`,
    `- korean-taxlaw-mcp: ${clean(installed?.taxlaw?.version)} / ${clean(installed?.taxlaw?.commit?.slice(0, 12))}`,
    '',
    `변경 후보: ${candidates.length}건`,
    ...(candidates.length ? candidates.map(candidateLine) : ['- 없음']),
    '',
    '조회 출처 상태',
    ...(sources.length ? sources.map(([name, source]) => `- ${clean(name)}: ${clean(source?.status)}`) : ['- 결과 파일 없음']),
    '',
    '이 점검은 변경 여부만 확인하며 자동 설치나 운영 재시작은 수행하지 않습니다.',
  ];
  return {
    subject: `[${label}] MCP 버전 점검 - ${execution.checked_at.slice(0, 10)}`,
    text: lines.join('\n'),
    state: { schema_version: 1, status: execution.status, checked_at: execution.checked_at },
  };
}

async function readState(stateDirectory) {
  try { return JSON.parse(await readFile(join(stateDirectory, 'email-state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('EMAIL_STATE_UNREADABLE'); }
}

async function saveState(stateDirectory, state) {
  const target = join(stateDirectory, 'email-state.json');
  const temporary = join(stateDirectory, `.email-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

export async function sendUpstreamEmail({ configPath, stateDirectory, report, execution, transportFactory } = {}) {
  const config = await loadEmailConfig(configPath);
  const previous = await readState(stateDirectory);
  const prepared = prepareEmail(report, execution, previous);
  const key = createHash('sha256').update(`${execution.status}\0${execution.checked_at}`).digest('hex');
  if (previous?.message_key === key) return { sent: false, reason: 'duplicate' };
  const factory = transportFactory || (options => nodemailer.createTransport(options));
  const transport = factory({ host: config.host, port: config.port, secure: config.secure,
    auth: { user: config.user, pass: config.pass }, tls: { minVersion: 'TLSv1.2', servername: config.host },
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000 });
  const result = await transport.sendMail({
    from: `"TaxLab MCP Monitor" <${config.user}>`, to: config.to,
    subject: prepared.subject, text: prepared.text,
  });
  if (Array.isArray(result?.rejected) && result.rejected.length) throw new Error('EMAIL_RECIPIENT_REJECTED');
  await saveState(stateDirectory, { ...prepared.state, message_key: key, sent_at: new Date().toISOString(),
    recipient: config.to });
  return { sent: true, message_id: clean(result?.messageId) };
}

export function validateEmailConfigFilename(path) {
  if (basename(path) !== 'upstream-email.env') throw new Error('EMAIL_CONFIG_FILENAME_INVALID');
  if (dirname(path) === '.') throw new Error('EMAIL_CONFIG_PATH_INVALID');
}
