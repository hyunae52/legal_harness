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
