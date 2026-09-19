import 'dotenv/config';
import assert from 'node:assert/strict';
if(!process.env.TAXLAB_API_KEY)throw Error('Set TAXLAB_API_KEY for this local manual check');
async function check(body) {
  const r=await fetch('http://127.0.0.1:3000/api/validate',{method:'POST',headers:{'content-type':'application/json','x-api-key':process.env.TAXLAB_API_KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  assert.equal(r.status,200);return r.json();
}
const incomplete=await check({draft_answer:'분담금의 원가 안분을 검토한다.'});
assert.equal(incomplete.passed,false);assert.ok(incomplete.checks.some(c=>c.status==='needs_info'));
const arithmetic=await check({draft_answer:'Synthetic arithmetic',facts:{allocation:{total:100,parts:[60,60]}}});
assert.equal(arithmetic.blocked,true);
const bypass=await check({draft_answer:'Synthetic arithmetic',facts:{allocation:{total:100,parts:[60,60]}},force:true,bypass_reason:'Manual test only'});
assert.equal(bypass.blocked,false);assert.equal(bypass.scoped_pass,false);assert.equal(bypass.checks[0].status,'fail');
console.log('Local validation contracts passed; legal conclusions remain unverified.');
