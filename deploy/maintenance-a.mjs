import {createServer} from 'node:http';
const server=createServer((_req,res)=>{
  res.writeHead(503,{'content-type':'application/json','cache-control':'no-store','retry-after':'300'});
  res.end(JSON.stringify({status:'maintenance',code:'SERVICE_UNAVAILABLE'}));
});
server.listen(3101,'127.0.0.1');
server.headersTimeout=10000;server.requestTimeout=10000;server.maxConnections=20;
process.once('SIGTERM',()=>{server.closeAllConnections();server.close();});
