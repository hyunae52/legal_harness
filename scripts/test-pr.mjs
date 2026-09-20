import 'dotenv/config';
import assert from 'node:assert/strict';
if(!process.env.TAXLAB_API_KEY)throw Error('Set TAXLAB_API_KEY for this local manual check');
// The legacy public route must not produce a PR or approve its own proposal.
const r=await fetch('http://127.0.0.1:3000/api/evolve',{method:'POST',headers:{'content-type':'application/json','x-api-key':process.env.TAXLAB_API_KEY},body:'{}',signal:AbortSignal.timeout(5000)});
assert.equal(r.status,410);assert.equal((await r.json()).code,'USE_SUBMIT_FAILURE');
console.log('Legacy automatic PR route is closed. No PR was requested.');
