import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import { publicSessionPattern } from './publicAccess.js';
/** Only expected upstream tool-result diagnostics enter this sanitizer. Never
 * pass an exception, stderr, stack or arbitrary server object to it. */
export function safeToolDiagnostic(result:CallToolResult,env:NodeJS.ProcessEnv):CallToolResult {
  const secrets=Object.entries(env).filter(([key,value])=>value&&value.length>=4&&/key|token|secret|password|^LAW_OC$/i.test(key)).flatMap(([,v])=>[v!,encodeURIComponent(v!)]);
  const omitted='[OMITTED: unparseable or encoded diagnostic]';
  const maxDepth=6;
  const scrub=(input:string,max=2000)=>{
    let text=input;
    for(const secret of secrets)text=text.split(secret).join('[REDACTED]');
    text=text.replace(new RegExp(publicSessionPattern.source, 'g'),'[REDACTED]');
    text=text.replace(/([?&](?:OC|apiKey|key|token|password)=)[^&#\s]+/gi,'$1[REDACTED]')
      .replace(/\bBearer\s+[^\s"']+/gi,'Bearer [REDACTED]')
      .replace(/\b((?:[A-Z_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)|Authorization|OC))\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1=[REDACTED]')
      .replace(/^\s*(?:at\s+.+|Traceback.*|File ".+", line .*)$/gm,'[INTERNAL TRACE OMITTED]')
      .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}/g,'[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]');
    return text.slice(0,max);
  };
  let budget=120;
  // MCP peers commonly serialize error objects into content.text (sometimes
  // more than once). Decode the whole JSON value before applying field policy;
  // regex-only filtering cannot see headers or JSON-escaped credentials.
  const cleanText=(input:string,max:number,depth:number):string=>{
    if(depth>maxDepth||input.length>24000)return omitted;
    const trimmed=input.trim();
    if(/^[{[\"]/.test(trimmed)) {
      let parsed:unknown;
      try {parsed=JSON.parse(trimmed);} catch {return omitted;}
      const cleaned=clean(parsed,depth+1);
      const text=typeof cleaned==='string'?cleaned:JSON.stringify(cleaned);
      return text.length<=max?text:'{"diagnostics_truncated":true}';
    }
    // Mixed prose/JSON and escaped fragments have no reliable structural
    // boundary. Do not expose opaque fragments as a supposedly safe message.
    if(/[{}]|\\(?:u[0-9a-f]{4}|["\\/bfnrt])/i.test(input))return omitted;
    return scrub(input,max);
  };
  const clean=(value:unknown,depth=0):unknown=>{
    if(--budget<0||depth>maxDepth)return '[OMITTED]';
    if(typeof value==='string')return cleanText(value,2000,depth);
    if(typeof value==='number'&&secrets.includes(String(value)))return '[REDACTED]';
    if(value===null||typeof value==='boolean'||typeof value==='number')return value;
    if(Array.isArray(value))return value.slice(0,20).map(v=>clean(v,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:client_session|token|password|secret|headers?|authorization|cookie|stack|stderr|environment|^env$|api.?key|(?:^|_)oc$|__proto__|constructor)/i.test(key)).slice(0,20).map(([k,v])=>[cleanText(k,100,depth+1),clean(v,depth+1)]));
    return null;
  };
  const content=result.content.filter(c=>c.type==='text').slice(0,3).map(c=>({type:'text' as const,text:cleanText(c.text,3000,0)}));
  if(!content.length)content.push({type:'text',text:'Upstream tool reported an error. Check the tool arguments or source availability.'});
  const structured=clean(result.structuredContent);
  const output:CallToolResult={isError:true,content,...(structured&&typeof structured==='object'&&!Array.isArray(structured)?{structuredContent:structured as Record<string,unknown>}:{})};
  if(Buffer.byteLength(JSON.stringify(output),'utf8')>16000)return {isError:true,content:[{type:'text',text:scrub(content[0].text,2000)}],structuredContent:{diagnostics_truncated:true}};
  return output;
}
