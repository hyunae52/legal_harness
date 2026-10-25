import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStore, readMorningUsage, readUsage, usageMorning } from '../dist/usage.js';
import { prepareUsageMail, sendUsageMail } from '../dist/usageMail.js';

async function fixture(t, start='2026-10-24T20:00:00Z') {
  const root=await mkdtemp(join(tmpdir(),'taxlab-usage-mail-'));
  let wall=Date.parse(start), elapsed=0;
  const database=join(root,'usage.sqlite'), config=join(root,'mail.env'), state=join(root,'state');
  const store=new UsageStore(database,()=>wall,()=>elapsed);
  store.registerTools(['search_law']);
  await writeFile(config,'SMTP_USER=sender@example.com\nSMTP_APP_PASSWORD=example-test-password\n',{mode:0o600});
  t.after(async()=>{store.close(); await rm(root,{recursive:true,force:true});});
  return {root,database,config,state,store,to:'reader@example.com',
    at(iso){wall=Date.parse(iso);},
    call(scope='mcp',success=true){const finish=store.start(scope,'search_law');elapsed+=250;finish(success);},
    finishAfterBoundary(){const finish=store.start('mcp','search_law');wall+=2000;elapsed+=2000;finish(true);},
  };
}

test('06-to-06 KST counts completion, keeps midnight totals and excludes internal source calls',async t=>{
  const f=await fixture(t);
  f.at('2026-10-24T20:59:59Z'); f.finishAfterBoundary(); // 05:59:59 -> 06:00:01 KST
  f.at('2026-10-25T15:00:00Z');f.call(); f.call('mcp',false); f.call('source'); f.call('rest');
  f.at('2026-10-25T21:00:00Z');f.call(); // next report
  const report=readMorningUsage(f.database,Date.parse('2026-10-25T21:00:00Z'));
  assert.equal(report.from,'2026-10-24T21:00:00.000Z');
  assert.equal(report.to,'2026-10-25T21:00:00.000Z');
  assert.equal(report.partial,false);
  assert.deepEqual(report.totals.mcp,{calls:3,successes:2,failures:1,duration_ms:2500,max_ms:2000});
  assert.equal(report.totals.source.calls,1);assert.equal(report.totals.rest.calls,1);
  assert.equal(readUsage(f.database,3,Date.parse('2026-10-25T21:00:00Z')).totals.mcp.calls,4);
  assert.equal(usageMorning(Date.parse('2026-10-25T20:59:59Z')),Date.parse('2026-10-24T21:00:00Z'));
});

test('first collection is visibly partial, missing migration is not reported as zero',async t=>{
  const f=await fixture(t,'2026-10-25T09:00:00Z');f.call();
  const report=readMorningUsage(f.database,Date.parse('2026-10-25T21:00:00Z'));
  assert.equal(report.partial,true);assert.equal(report.totals.mcp.calls,1);
  const message=prepareUsageMail(report);assert.match(message.subject,/부분 집계/);assert.match(message.text,/2026-10-25 18:00/);
  const notYet=readMorningUsage(f.database,Date.parse('2026-10-25T10:00:00Z'));
  assert.equal(notYet.no_coverage,true);
  const db=new DatabaseSync(f.database);db.exec("DELETE FROM usage_meta WHERE key='morning_started_at'");db.close();
  assert.throws(()=>readMorningUsage(f.database),/USAGE_MORNING_NOT_READY/);
});

test('daily and morning counters roll back together when either write fails',async t=>{
  const f=await fixture(t);
  const db=new DatabaseSync(f.database);db.exec("CREATE TRIGGER reject_morning BEFORE INSERT ON usage_morning BEGIN SELECT RAISE(ABORT,'fixture'); END");db.close();
  f.call();
  assert.equal(f.store.status().failed_writes,1);
  assert.deepEqual(readUsage(f.database,1,Date.parse('2026-10-24T20:00:00Z')).totals,{});
  assert.deepEqual(readMorningUsage(f.database,Date.parse('2026-10-25T21:00:00Z')).totals,{});
});

test('private delivery claim prevents concurrent and repeated mail, recipient is explicit',async t=>{
  const f=await fixture(t);f.at('2026-10-25T01:00:00Z');f.call();
  const deliveries=[];
  const options={...f,now:Date.parse('2026-10-25T21:00:00Z'),transportFactory:()=>({sendMail:async message=>{
    deliveries.push(message);return {accepted:[f.to],rejected:[]};
  }})};
  const outcomes=await Promise.allSettled([sendUsageMail(options),sendUsageMail(options)]);
  assert.equal(deliveries.length,1);
  assert.equal(outcomes.filter(item=>item.status==='fulfilled'&&item.value.sent).length,1,
    JSON.stringify(outcomes.map(item=>item.status==='rejected'?{error:item.reason.message,code:item.reason.code}:item.value)));
  assert.deepEqual(await sendUsageMail(options),{sent:false,reason:'duplicate'});
  assert.equal(deliveries[0].to,'reader@example.com');
  assert.match(deliveries[0].text,/MCP 도구 호출: 1회/);assert.match(deliveries[0].text,/방문자 수가 아닙니다/);
  assert.ok(!JSON.stringify(deliveries).includes('example-test-password'));
  for(const name of await readdir(f.state))assert.ok(!(await readFile(join(f.state,name),'utf8')).includes('example-test-password'));
});

test('ambiguous SMTP failure leaves an explicit pending state and is never retried blindly',async t=>{
  const f=await fixture(t);let sends=0;
  const options={...f,now:Date.parse('2026-10-25T21:00:00Z'),transportFactory:()=>({sendMail:async()=>{
    sends++;throw Error('fixture dropped acknowledgement');
  }})};
  await assert.rejects(sendUsageMail(options),/dropped acknowledgement/);
  await assert.rejects(sendUsageMail(options),/USAGE_MAIL_DELIVERY_UNCONFIRMED/);
  assert.equal(sends,1);
});
