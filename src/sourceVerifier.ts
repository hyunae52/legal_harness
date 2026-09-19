import { z } from 'zod';
import { digest, ServiceError } from './contracts.js';
import type { KoreanLawClient } from './koreanLawClient.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(s + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s;
}, 'Invalid calendar date');
export const SourceRequest = z.object({ law_name:z.string().trim().min(1).max(120), law_id:z.string().regex(/^\d{1,12}$/),
  article:z.string().trim().min(1).max(40).optional(), event_dates:z.record(z.enum(['contract','transfer','management_disposal','tax_period_start']),date).default({}) }).strict();
type SourceClient = Pick<KoreanLawClient,'callTool'|'listTools'|'close'>;
/** Each refresh uses a fresh upstream child, so upstream's in-process cache
 * cannot silently turn a current-source check into reuse of yesterday's text. */
export class SourceVerifier {
  private active = false;
  private stopped = false;
  private client?: SourceClient;
  private controller?: AbortController;
  private previous = new Map<string,{ at:number; result:Record<string,unknown>; hash:string }>();
  constructor(private factory:()=>SourceClient, private now=()=>Date.now(), private timeoutMs=32_000) {}
  async close() {
    this.stopped = true;
    this.controller?.abort(new ServiceError(503,'SOURCE_REFRESH_STOPPED'));
    await this.client?.close();
  }
  async check(input:unknown) {
    const request=SourceRequest.parse(input);
    if(this.stopped) throw new ServiceError(503,'SOURCE_REFRESH_STOPPED');
    if(this.active) throw new ServiceError(429,'SOURCE_REFRESH_CAPACITY');
    this.active=true;
    const key=digest(request), old=this.previous.get(key);
    let client:SourceClient|undefined;
    const controller = new AbortController(); this.controller=controller;
    const timer=setTimeout(()=>controller.abort(new ServiceError(504,'SOURCE_REFRESH_TIMEOUT')),this.timeoutMs);
    const aborted = new Promise<never>((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
    try {
      const source=this.factory(); client=source; this.client=source;
      const refresh = async () => {
      const catalog=await source.listTools();
      controller.signal.throwIfAborted();
      const current=await source.callTool('get_law_text',{lawId:request.law_id,...(request.article?{jo:request.article}:{})});
      controller.signal.throwIfAborted();
      const text=current.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
      const name=/^법령명:\s*([^\n]+)$/m.exec(text)?.[1]?.trim();
      const normalize=(s:string)=>s.replace(/[\s·ㆍ]/g,'');
      if(!name || normalize(name)!==normalize(request.law_name)) throw new ServiceError(422,'SOURCE_IDENTITY_UNRESOLVED');
      const effective=/^시행일:\s*(\d{8})$/m.exec(text)?.[1];
      const promulgation=/^공포일:\s*(\d{8})$/m.exec(text)?.[1];
      const observations=[];
      for(const [role,at] of Object.entries(request.event_dates)) {
        const result=await source.callTool('execute_tool',{tool_name:'applicable_law',params:{lawName:request.law_name,date:at,...(request.article?{jo:request.article}:{})}});
        controller.signal.throwIfAborted();
        observations.push({role,date:at,result:result.result,applicability:'unverified',transitional_provisions:'requires_interpretation'});
      }
      const hash=digest(current.result), now=this.now();
      const result={schema_version:1,source_access:'available',refresh_method:'fresh_upstream_process',checked_at:new Date(now).toISOString(),
        source:{agency:'Ministry of Government Legislation',url:`https://www.law.go.kr/법령/${encodeURIComponent(name)}`,law_id:request.law_id,name,promulgation_date:promulgation??null,effective_date:effective??null},
        upstream_version:catalog.server?.version??'unidentified',content_hash:hash,previous_content_changed:old?old.hash!==hash:null,
        version_selection:!effective?'unresolved':effective>new Date(now).toISOString().slice(0,10).replaceAll('-','')?'future':'current_candidate',
        current_result:current.result,historical_observations:observations,applicability:'unverified',subsequent_interpretations:'unverified',
        note:'Fresh source retrieval is not a determination of transitional provisions or the continuing validity of interpretations.'};
      // Bound in-memory fallback to at most 20 * 200KB. Never cache oversized results.
      if(Buffer.byteLength(JSON.stringify(result),'utf8')<=200_000) {
        this.previous.delete(key);this.previous.set(key,{at:now,result,hash});
        if(this.previous.size>20) this.previous.delete(this.previous.keys().next().value!);
      }
      return result;
      };
      return await Promise.race([refresh(),aborted]);
    } catch(error) {
      const usable=old && this.now()-old.at<86_400_000 ? old : undefined;
      return {schema_version:1,source_access:'unavailable',version_selection:'unresolved',applicability:'unverified',
        checked_at:new Date(this.now()).toISOString(),error_code:error instanceof ServiceError?error.code:'SOURCE_REFRESH_FAILED',
        previous:usable?{age_seconds:Math.floor((this.now()-usable.at)/1000),result:usable.result}:null};
    } finally {
      clearTimeout(timer);
      try { await client?.close(); }
      finally { this.client=undefined;this.controller=undefined;this.active=false; }
    }
  }
}
