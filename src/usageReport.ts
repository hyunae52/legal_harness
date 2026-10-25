import { readUsage } from './usage.js';

try {
  const args = process.argv.slice(2);
  let path = process.env.TAXLAB_USAGE_DB, days = 7, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--database') path = args[++i];
    else if (args[i] === '--days') days = Number(args[++i]);
    else if (args[i] === '--json') json = true;
    else throw Error('USAGE_REPORT_INPUT');
  }
  if (!path) throw Error('USAGE_REPORT_INPUT');
  const report = readUsage(path, days);
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`MCP 사용 통계: ${report.from} ~ ${report.to} (${report.timezone})`);
    console.log(`기록 시작: ${report.started_at}. MCP·REST와 내부 조회(source)는 별도 집계입니다.`);
    console.table(Object.entries(report.totals).map(([scope, item]) => ({ scope, calls: item.calls, successes: item.successes,
      failures: item.failures, mean_ms: Math.round(item.mean_ms), max_ms: Math.round(item.max_ms) })));
    console.table(report.daily_tools.map(row => ({ day: row.day, scope: row.scope, tool: row.tool, calls: row.calls,
      failures: row.failures, mean_ms: Math.round(row.mean_ms) })));
    console.log(`오류 코드 집계 시작: ${report.failure_started_at ?? '기록 없음'}. UNRECORDED는 원인 기록 없음입니다.`);
    console.table(report.failure_reasons);
  }
} catch {
  console.error('USAGE_REPORT_UNAVAILABLE: use --database ABSOLUTE_PATH --days 1..400 [--json]; the database must already exist.');
  process.exitCode = 1;
}
