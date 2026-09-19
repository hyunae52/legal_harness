import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
/** Only expected upstream tool-result diagnostics enter this sanitizer. Never
 * pass an exception, stderr, stack or arbitrary server object to it. */
export function safeToolDiagnostic(result:CallToolResult,env:NodeJS.ProcessEnv):CallToolResult {
  const secrets=Object.entries(env).filter(([key,value])=>value&&value.length>=4&&/key|token|secret|password|^LAW_OC$/i.test(key)).flatMap(([,v])=>[v!,encodeURIComponent(v!)]);
  const scrub=(input:string,max=2000)=>{
    let text=input;
    for(const secret of secrets)text=text.split(secret).join('[REDACTED]');
    text=text.replace(/([?&](?:OC|apiKey|key|token|password)=)[^&#\s]+/gi,'$1[REDACTED]')
      .replace(/\bBearer\s+[^\s"']+/gi,'Bearer [REDACTED]')
      .replace(/\b((?:[A-Z_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)|Authorization|OC))\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1=[REDACTED]')
      .replace(/^\s*(?:at\s+.+|Traceback.*|File ".+", line .*)$/gm,'[INTERNAL TRACE OMITTED]')
      .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}/g,'[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]');
    return text.slice(0,max);
  };
  let budget=120;
  const clean=(value:unknown,depth=0):unknown=>{
    if(--budget<0||depth>4)return '[OMITTED]';
    if(typeof value==='string')return scrub(value);
    if(value===null||typeof value==='boolean'||typeof value==='number')return value;
    if(Array.isArray(value))return value.slice(0,20).map(v=>clean(v,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:token|password|secret|headers?|authorization|cookie|stack|stderr|environment|^env$|api.?key|^oc$|__proto__|constructor)/i.test(key)).slice(0,20).map(([k,v])=>[scrub(k,100),clean(v,depth+1)]));
    return null;
  };
  const content=result.content.filter(c=>c.type==='text').slice(0,3).map(c=>({type:'text' as const,text:scrub(c.text,3000)}));
  if(!content.length)content.push({type:'text',text:'Upstream tool reported an error. Check the tool arguments or source availability.'});
  const structured=clean(result.structuredContent);
  const output:CallToolResult={isError:true,content,...(structured&&typeof structured==='object'&&!Array.isArray(structured)?{structuredContent:structured as Record<string,unknown>}:{})};
  if(Buffer.byteLength(JSON.stringify(output),'utf8')>16000)return {isError:true,content:[{type:'text',text:scrub(content[0].text,2000)}],structuredContent:{diagnostics_truncated:true}};
  return output;
}
