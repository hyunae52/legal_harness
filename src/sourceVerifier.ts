import {z} from 'zod';
import {digest,ServiceError} from './contracts.js';
import type {KoreanLawClient} from './koreanLawClient.js';
import { CalendarDay } from './dates.js';

const date=CalendarDay;
export const SourceRequest=z.object({law_name:z.string().trim().min(1).max(120),law_id:z.string().regex(/^\d{1,12}$/),
  article:z.string().trim().min(1).max(40).optional(),event_dates:z.record(z.enum(['contract','transfer','management_disposal','tax_period_start']),date).default({})}).strict();
type SourceClient=Pick<KoreanLawClient,'callTool'|'listTools'|'close'>;
const errorCode=(error:unknown)=>error instanceof ServiceError?error.code:'SOURCE_REFRESH_FAILED';
function koreanDate(at:number){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
  return ['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('');
}
/** Fresh upstream children avoid silently reusing an in-process law cache. */
export class SourceVerifier {
  private active=false;
  private stopped=false;
  private client?:SourceClient;
  private controller?:AbortController;
  private previous=new Map<string,{at:number;result:Record<string,unknown>;hash:string}>();
  constructor(private factory:()=>SourceClient,private now=()=>Date.now(),private timeoutMs=32_000){}
  async close(){this.stopped=true;this.controller?.abort(new ServiceError(503,'SOURCE_REFRESH_STOPPED'));await this.client?.close();}
  async check(input:unknown){
    const request=SourceRequest.parse(input);
    if(this.stopped)throw new ServiceError(503,'SOURCE_REFRESH_STOPPED');
    if(this.active)throw new ServiceError(429,'SOURCE_REFRESH_CAPACITY');
    this.active=true;
    const key=digest(request),old=this.previous.get(key),controller=new AbortController();this.controller=controller;
    const timer=setTimeout(()=>controller.abort(new ServiceError(504,'SOURCE_REFRESH_TIMEOUT')),this.timeoutMs);
    const aborted=new Promise<never>((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
    const bounded=<T>(operation:()=>Promise<T>)=>{controller.signal.throwIfAborted();return Promise.race([operation(),aborted]);};
    let client:SourceClient|undefined;
    try {
      const source=this.factory();client=source;this.client=source;
      const catalog=await bounded(()=>source.listTools());
      const current=await bounded(()=>source.callTool('get_law_text',{lawId:request.law_id,...(request.article?{jo:request.article}:{})}));
      const text=current.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
      const name=/^법령명:\s*([^\n]+)$/m.exec(text)?.[1]?.trim();
      const normalize=(s:string)=>s.replace(/[\s·ㆍ]/g,'');
      if(!name||normalize(name)!==normalize(request.law_name))throw new ServiceError(422,'SOURCE_IDENTITY_UNRESOLVED');
      const effective=/^시행일:\s*(\d{8})$/m.exec(text)?.[1];
      const promulgation=/^공포일:\s*(\d{8})$/m.exec(text)?.[1];
      const observations=[];
      // Each historical role has its own access status. Failure must not erase
      // a successfully fetched current source or other successful role results.
      for(const [role,at] of Object.entries(request.event_dates)){
        try {
          const response=await bounded(()=>source.callTool('execute_tool',{tool_name:'applicable_law',params:{lawName:request.law_name,date:at,...(request.article?{jo:request.article}:{})}}));
          observations.push({role,date:at,source_access:'available',result:response.result,applicability:'unverified',transitional_provisions:'requires_interpretation'});
        }catch(error){observations.push({role,date:at,source_access:'unavailable',error_code:errorCode(error),result:null,applicability:'unverified',transitional_provisions:'unverified'});}
      }
      const hash=digest(current.result),now=this.now();
      const result={schema_version:1,source_access:'available',refresh_method:'fresh_upstream_process',checked_at:new Date(now).toISOString(),evaluation_timezone:'Asia/Seoul',
        source:{agency:'Ministry of Government Legislation',url:`https://www.law.go.kr/법령/${encodeURIComponent(name)}`,law_id:request.law_id,name,promulgation_date:promulgation??null,effective_date:effective??null},
        upstream_version:catalog.server?.version??'unidentified',content_hash:hash,previous_content_changed:old?old.hash!==hash:null,
        version_selection:!effective?'unresolved':effective>koreanDate(now)?'future':'current_candidate',
        current_result:current.result,historical_observations:observations,
        historical_access:observations.length===0?'not_requested':observations.every(o=>o.source_access==='available')?'available':observations.some(o=>o.source_access==='available')?'partial':'unavailable',
        applicability:'unverified',subsequent_interpretations:'unverified',
        note:'Fresh source retrieval does not determine transitional provisions or continuing validity of interpretations.'};
      // Bound fallback to 20 * 200KB; oversized results are never cached.
      if(Buffer.byteLength(JSON.stringify(result),'utf8')<=200_000){
        this.previous.delete(key);this.previous.set(key,{at:now,result,hash});
        if(this.previous.size>20)this.previous.delete(this.previous.keys().next().value!);
      }
      return result;
    }catch(error){
      const usable=old&&this.now()-old.at<86_400_000?old:undefined;
      return {schema_version:1,source_access:'unavailable',version_selection:'unresolved',applicability:'unverified',
        checked_at:new Date(this.now()).toISOString(),error_code:errorCode(error),previous:usable?{age_seconds:Math.floor((this.now()-usable.at)/1000),result:usable.result}:null};
    }finally{
      clearTimeout(timer);
      try{await client?.close();}finally{this.client=undefined;this.controller=undefined;this.active=false;}
    }
  }
}
