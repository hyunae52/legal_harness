#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const origin = new URL(process.env.TAXLAB_SERVER_URL || 'https://law.taxlab.kr');
const loopback = ['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
if ((origin.protocol !== 'https:' && !(loopback && process.env.TAXLAB_ALLOW_LOOPBACK_HTTP === '1')) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('TAXLAB_SERVER_URL must be an HTTPS origin without credentials or query parameters.');
}
const token = process.env.TAXLAB_API_KEY || process.env.TAXLAB_AUTH_TOKEN;
if (!token) throw new Error('Set TAXLAB_API_KEY or TAXLAB_AUTH_TOKEN in the MCP client environment.');
const headers = process.env.TAXLAB_AUTH_TOKEN ? {authorization:'Bearer '+process.env.TAXLAB_AUTH_TOKEN} : {'x-api-key':token};
const safeFetch = (url, init) => {
  if (new URL(url).origin !== origin.origin) throw new Error('Cross-origin MCP request blocked.');
  return fetch(url,{...init,redirect:'error'});
};
let remote, connecting, stopped=false;
async function getRemote() {
  if (stopped) throw new Error('Bridge closed.');
  if (remote) return remote;
  if (connecting) return connecting;
  connecting=(async()=>{
    const client=new Client({name:'taxlab-stdio-bridge',version:'2.2.0'});
    client.onclose=()=>{if(remote===client) remote=undefined;};
    const transport=new SSEClientTransport(new URL('/sse',origin),{requestInit:{headers},fetch:safeFetch});
    try { await client.connect(transport,{timeout:15000}); if(stopped){await client.close();throw new Error('Bridge closed.');} remote=client; return client; }
    catch(error){await transport.close();throw error;}
  })();
  try{return await connecting;}finally{connecting=undefined;}
}
const local=new Server({name:'taxlab-legal-bridge',version:'2.2.0'},{capabilities:{tools:{}}});
local.setRequestHandler(ListToolsRequestSchema,async()=>await(await getRemote()).listTools(undefined,{timeout:15000}));
// A lost response may already have committed a failure receipt. Do not replay.
local.setRequestHandler(CallToolRequestSchema,async request=>{
  try{return await(await getRemote()).callTool(request.params,undefined,{timeout:45000});}
  catch{await remote?.close();remote=undefined;return {isError:true,content:[{type:'text',text:'Remote request failed. Check connection; for writes, query the existing receipt before retrying.'}]};}
});
async function close(){if(stopped)return;stopped=true;await remote?.close();await local.close();}
local.onclose=()=>void close();
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
try {
  if(process.argv.includes('--doctor')) {
    const health=await safeFetch(new URL('/health',origin),{headers,signal:AbortSignal.timeout(10000)});
    if(!health.ok) throw new Error('Health failed');
    const tools=await(await getRemote()).listTools(undefined,{timeout:15000});
    if(!tools.tools.some(t=>t.name==='search_law')) throw new Error('Catalog missing law tools');
    console.log(JSON.stringify({status:'ok',origin:origin.origin,tools:tools.tools.length}));await close();
  } else {await local.connect(new StdioServerTransport());}
} catch {console.error('Legal MCP connection failed. Verify HTTPS, authentication and installed package; no request was automatically replayed.');await close();process.exitCode=1;}
