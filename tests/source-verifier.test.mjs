import assert from 'node:assert/strict';
import test from 'node:test';
import {SourceVerifier} from '../dist/sourceVerifier.js';
test('freshness check opens fresh upstream, preserves role dates, detects change and labels stale fallback',async()=>{
  let count=0,closed=0,fail=false,body='법령명: 근로기준법\n공포일: 20240101\n시행일: 20240101\nFixture',time=Date.parse('2026-09-19T00:00:00Z');
  const calls=[];
  const verifier=new SourceVerifier(()=>{count++;return {listTools:async()=>({server:{version:'4.13.0'}}),close:async()=>{closed++;},callTool:async(name,args)=>{
    calls.push({name,args});if(fail) throw Error('secret');return {result:{content:[{type:'text',text:name==='get_law_text'?body:'historical/addenda candidate'}]}};
  }};},()=>time);
  const input={law_name:'근로기준법',law_id:'001872',event_dates:{contract:'2024-02-01',transfer:'2025-03-01'}};
  const first=await verifier.check(input);assert.equal(first.source_access,'available');assert.equal(first.historical_observations.length,2);assert.equal(first.applicability,'unverified');
  assert.equal(calls[1].args.params.date,'2024-02-01');
  body+=' changed';const second=await verifier.check(input);assert.equal(second.previous_content_changed,true);assert.equal(count,2);assert.equal(closed,2);
  fail=true;time+=60000;const outage=await verifier.check(input);assert.equal(outage.source_access,'unavailable');assert.equal(outage.previous.age_seconds,60);assert.equal(outage.version_selection,'unresolved');
  time+=86_400_000;assert.equal((await verifier.check(input)).previous,null);
  await assert.rejects(verifier.check({...input,event_dates:{contract:'2024-02-30'}}));
});
test('wrong law identity and future effective dates do not become historical/current confirmation',async()=>{
  let law='Other',effective='20300101';
  const verifier=new SourceVerifier(()=>({listTools:async()=>({}),close:async()=>{},callTool:async()=>({result:{content:[{type:'text',text:`법령명: ${law}\n시행일: ${effective}`}]}})}));
  const input={law_name:'Expected',law_id:'1'};
  assert.equal((await verifier.check(input)).error_code,'SOURCE_IDENTITY_UNRESOLVED');
  law='Expected';assert.equal((await verifier.check(input)).version_selection,'future');
});
test('a hung source refresh has an overall deadline and shutdown prevents new children',async()=>{
  let closed=0,opened=0;
  const verifier=new SourceVerifier(()=>{opened++;return {listTools:()=>new Promise(()=>{}),callTool:async()=>{},close:async()=>{closed++;}};},()=>Date.now(),25);
  const input={law_name:'Fixture',law_id:'1'};
  const pending=verifier.check(input);
  await assert.rejects(verifier.check(input),e=>e.code==='SOURCE_REFRESH_CAPACITY');
  assert.equal((await pending).error_code,'SOURCE_REFRESH_TIMEOUT');assert.equal(closed,1);
  const next=verifier.check(input);await verifier.close();assert.equal((await next).error_code,'SOURCE_REFRESH_STOPPED');
  await assert.rejects(verifier.check(input),e=>e.code==='SOURCE_REFRESH_STOPPED');assert.equal(opened,2);
});
test('partial history failure retains current source and successful roles; dates use Korea midnight',async()=>{
  let hang=false;
  const verifier=new SourceVerifier(()=>({listTools:async()=>({}),close:async()=>{},callTool:async(name,args)=>{
    if(name==='get_law_text')return {result:{content:[{type:'text',text:'법령명: Fixture\n시행일: 20260920'}]}};
    if(args.params.date==='2024-01-01'){if(hang)return new Promise(()=>{});throw Error('history dependency failure');}
    return {result:{content:[{type:'text',text:'successful history'}]}};
  }}),()=>Date.parse('2026-09-19T15:00:00Z'),25);
  const input={law_name:'Fixture',law_id:'1',event_dates:{transfer:'2025-01-01',contract:'2024-01-01'}};
  for(hang of [false,true]) {
    const r=await verifier.check(input);assert.equal(r.source_access,'available');assert.equal(r.version_selection,'current_candidate');assert.equal(r.evaluation_timezone,'Asia/Seoul');
    assert.equal(r.historical_access,'partial');assert.equal(r.historical_observations[0].source_access,'available');assert.equal(r.historical_observations[1].source_access,'unavailable');assert.ok(r.current_result);
  }
});
test('effective date switches at Korea midnight, not UTC midnight',async()=>{
  let at=0;
  const verifier=new SourceVerifier(()=>({listTools:async()=>({}),close:async()=>{},callTool:async()=>({result:{content:[{type:'text',text:'법령명: Fixture\n시행일: 20260919'}]}})}),()=>at);
  for(const [time,expected] of [['2026-09-18T23:59:59+09:00','future'],['2026-09-19T00:00:00+09:00','current_candidate'],['2026-09-19T08:59:59+09:00','current_candidate'],['2026-09-19T09:00:00+09:00','current_candidate']]){
    at=Date.parse(time);assert.equal((await verifier.check({law_name:'Fixture',law_id:'1'})).version_selection,expected);
  }
});
