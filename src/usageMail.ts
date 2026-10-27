import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'dotenv';
import { readMorningUsage } from './usage.js';
import { failureLabels, type FailureCategory } from './usageFailures.js';

type Report = ReturnType<typeof readMorningUsage>;
const email = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const koreanTime = (iso: string) => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ');

export function prepareUsageMail(report: Report, test = false) {
  const mcp = report.totals.mcp ?? { calls: 0, successes: 0, failures: 0, duration_ms: 0, max_ms: 0 };
  const rate = mcp.calls ? `${(100 * mcp.successes / mcp.calls).toFixed(1)}%` : '—';
  const period = `${koreanTime(report.from)} ~ ${koreanTime(report.to)} (한국시간)`;
  const top = report.tools.filter(row => row.scope === 'mcp').sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)).slice(0, 10);
  const subject = test ? '[설정 확인] MCP 사용량 메일 · 매일 오전 6시' :
    `[MCP 사용량${report.partial ? ' · 부분 집계' : ''}] ${koreanTime(report.to).slice(0, 10)} · ${mcp.calls.toLocaleString('ko-KR')}회`;
  const notice = report.no_coverage ? '새로운 06시 기준 집계가 시작되었습니다. 첫 정규 메일은 다음 오전 6시에 발송됩니다.' :
    report.partial ? `부분 집계: ${koreanTime(report.started_at)}부터 기록했습니다. 이전 시간대는 포함되지 않습니다.` : '';
  const reasons = report.failure_reasons.filter(row => row.scope === 'mcp');
  const categories = new Map<FailureCategory, number>();
  const details = new Map<string, number>();
  for (const row of reasons) {
    categories.set(row.category, (categories.get(row.category) ?? 0) + row.failures);
    const key = `${row.tool} / ${row.code}`;
    details.set(key, (details.get(key) ?? 0) + row.failures);
  }
  const ordered = [...categories].sort((a, b) => b[1] - a[1]);
  const detailRows = [...details].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const failures = ['실패 원인 (MCP)', ...(ordered.length ? ordered.map(([category, count]) => `- ${failureLabels[category]}: ${count}건`) : ['- 실패 없음']),
    ...(detailRows.length ? ['', '도구별 오류 코드 (상위 10개)', ...detailRows.slice(0, 10).map(([key, count]) => `- ${key}: ${count}건`),
      ...(detailRows.length > 10 ? [`- 나머지 ${detailRows.length - 10}개 조합: ${detailRows.slice(10).reduce((sum, row) => sum + row[1], 0)}건`] : [])] : []),
    ...(categories.has('unrecorded') ? ['원인 기록 없음: 분류 도입 전 등 오류 코드가 남아 있지 않은 호출입니다. 원인을 추정하지 않습니다.'] : []),
    ...(categories.has('provider') ? ['EXTERNAL_API_ERROR는 외부 통신 오류와 조회 도구 내부 예외가 함께 사용하는 코드입니다. 외부 API 장애로 확정하지 않습니다.'] : []),
    ...(categories.has('unknown') ? ['원인 미분류: 오류 코드를 확인하지 못했거나 아직 분류하지 않은 오류입니다.'] : [])];
  const detailLines = ['많이 사용한 도구', ...(top.length ? top.map(row => `- ${row.tool}: ${row.calls}회 (실패 ${row.failures}회)`) : ['- 호출 없음']), '',
    ...failures, '', `REST 호출: ${report.totals.rest?.calls ?? 0}회 (별도)`,
    `내부 자료 조회: ${report.totals.source?.calls ?? 0}회 (MCP 합계에 더하지 않음)`];
  const notes = ['처리가 끝난 시각을 기준으로 집계합니다. 오전 6시를 넘겨 완료된 호출은 다음 메일에 포함됩니다.',
    '자체 작업과 외부 이용을 구분하지 않으며, 호출 수는 방문자 수가 아닙니다.',
    '배포 점검에서 잘못된 입력이 거절되는지 확인한 호출도 실패 건수에 포함됩니다.',
    '실패에는 입력 오류·조회 결과 오류도 포함됩니다. 질문·응답 본문과 사용자 식별자는 수집하지 않습니다.'];
  const lines = [test ? '매일 오전 6시 사용량 메일이 설정되었습니다.' : 'TaxLab MCP 하루 사용량', '',
    `집계 구간: ${period}`, ...(notice ? [notice] : []), '',
    ...(report.no_coverage ? [] : [`MCP 도구 호출: ${mcp.calls.toLocaleString('ko-KR')}회`,
      `성공 ${mcp.successes}회 / 실패 ${mcp.failures}회 / 성공률 ${rate}`,
      `평균 응답: ${mcp.calls ? (mcp.duration_ms / mcp.calls / 1000).toFixed(2) : '0.00'}초`, '',
      ...detailLines]), '', ...notes];
  const table = report.no_coverage ? '' : `<table style="width:100%;border-collapse:collapse"><tr style="background:#edf2f7"><th align="left">MCP 호출</th><th>성공</th><th>실패</th><th>성공률</th></tr><tr><td style="padding:14px;font-size:24px;font-weight:bold">${mcp.calls.toLocaleString('ko-KR')}</td><td align="center">${mcp.successes}</td><td align="center">${mcp.failures}</td><td align="center">${rate}</td></tr></table>`;
  const average = report.no_coverage ? '' : `<p>평균 응답 ${mcp.calls ? (mcp.duration_ms / mcp.calls / 1000).toFixed(2) : '0.00'}초</p>`;
  const html = `<div style="max-width:640px;margin:auto;font-family:Arial,sans-serif;line-height:1.6;color:#172b4d"><h2>${test ? '매일 오전 6시 사용량 메일' : 'TaxLab MCP 하루 사용량'}</h2><p>${escape(period)}</p>${notice ? `<p style="background:#fff3cd;padding:12px">${escape(notice)}</p>` : ''}${table}${average}<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px">${escape([...(report.no_coverage ? [] : detailLines), '', ...notes].join('\n'))}</pre></div>`;
  return { subject, text: lines.join('\n'), html };
}

type MailOptions = { database: string; config: string; state: string; to: string; now?: number; test?: boolean;
  transportFactory?: (options: Record<string, unknown>) => { sendMail(message: Record<string, unknown>): Promise<{ accepted?: unknown[]; rejected?: unknown[] }> } };

export async function sendUsageMail(options: MailOptions) {
  if (![options.database, options.config, options.state].every(isAbsolute) || !email.test(options.to)) throw Error('USAGE_MAIL_INPUT');
  const report = readMorningUsage(options.database, options.now);
  if (report.no_coverage && !options.test) return { sent: false, reason: 'collection_started_after_window' };
  const prepared = prepareUsageMail(report, options.test);
  const metadata = await stat(options.config);
  if (!metadata.isFile() || metadata.size > 8192 || (process.platform !== 'win32' &&
    ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.geteuid?.()))) throw Error('USAGE_MAIL_CONFIG_PERMISSIONS');
  const env = parse(await readFile(options.config, 'utf8'));
  const user = env.SMTP_USER, pass = env.SMTP_APP_PASSWORD?.replace(/\s+/g, '');
  if ((env.SMTP_HOST || 'smtp.gmail.com') !== 'smtp.gmail.com' || (env.SMTP_PORT || '465') !== '465' ||
    (env.SMTP_SECURE || 'true') !== 'true' || !email.test(user || '') || !pass || pass.length > 128 || /[\r\n\0]/.test(pass)) throw Error('USAGE_MAIL_CONFIG_INVALID');
  await mkdir(options.state, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(`${options.test ? 'setup' : 'daily'}\0${report.to}\0${options.to}`).digest('hex');
  const record = join(options.state, `${key}.json`);
  const receipt = join(options.state, `${key}.sent.json`);
  const previous = async () => {
    try {
      const saved = JSON.parse(await readFile(receipt, 'utf8'));
      if (saved.status === 'sent') return { sent: false, reason: 'duplicate' };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    throw Error('USAGE_MAIL_DELIVERY_UNCONFIRMED');
  };
  // Exclusive claim prevents concurrent timer/manual runs from sending twice.
  // Keep pending state on SMTP/acknowledgement uncertainty; never blindly resend.
  try { await writeFile(record, JSON.stringify({ status: 'pending', period_end: report.to, recipient: options.to }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return previous(); throw error; }
  const factory = options.transportFactory ?? (settings => createRequire(import.meta.url)('nodemailer').createTransport(settings));
  const transport = factory({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
    tls: { minVersion: 'TLSv1.2', servername: 'smtp.gmail.com' }, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000 });
  const result = await transport.sendMail({ from: `"TaxLab MCP" <${user}>`, to: options.to, ...prepared,
    messageId: `<usage-${key}@taxlab.kr>` });
  if (result.rejected?.length || !result.accepted?.includes(options.to)) throw Error('USAGE_MAIL_ACCEPTANCE_UNCONFIRMED');
  const temporary = join(options.state, `.sent-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ status: 'sent', period_end: report.to, recipient: options.to,
      sent_at: new Date(options.now ?? Date.now()).toISOString() }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, receipt);
  } finally { await rm(temporary, { force: true }); }
  return { sent: true, period_end: report.to, partial: report.partial };
}

async function main(args: string[]) {
  const options: Record<string, string> = {};
  let mode = 'preview';
  for (let i = 0; i < args.length; i++) {
    if (['--send', '--test', '--preview'].includes(args[i])) { mode = args[i].slice(2); continue; }
    if (!['--database', '--config', '--state', '--to'].includes(args[i]) || !args[i + 1]) throw Error('USAGE_MAIL_INPUT');
    options[args[i].slice(2)] = args[++i];
  }
  if (mode === 'preview') console.log(JSON.stringify(prepareUsageMail(readMorningUsage(options.database))));
  else console.log(JSON.stringify(await sendUsageMail({ database: options.database, config: options.config,
    state: options.state, to: options.to, test: mode === 'test' })));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => {
  console.error('USAGE_MAIL_FAILED: check configuration, database and private delivery state; uncertain deliveries are not resent automatically.');
  process.exitCode = 1;
});
