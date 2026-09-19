import 'dotenv/config';
import {SourceVerifier} from '../dist/sourceVerifier.js';
import {createKoreanLawClient} from '../dist/koreanLawClient.js';
// Explicit operator-only live read of public law; no private case material.
if(!process.argv.includes('--live'))throw Error('Use --live to request current public law from the official API.');
const verifier=new SourceVerifier(()=>createKoreanLawClient());
try {
  const r=await verifier.check({law_name:'근로기준법',law_id:'001872',event_dates:{contract:'2024-01-01'}});
  console.log(JSON.stringify({source_access:r.source_access,error_code:r.error_code??null,source:r.source??null,
    upstream_version:r.upstream_version??null,version_selection:r.version_selection,content_hash:r.content_hash??null,
    historical_observations:r.historical_observations?.length??0,applicability:r.applicability}));
  if(r.source_access!=='available')process.exitCode=1;
}finally{await verifier.close();}
