/** Test-only TLS ingress. The broker request executes the actual exported route
 * and production construct(), including TLS pg.Pool, Redis fetch and XFF checks.
 * Never imported by the application. All credentials/data are disposable. */
import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import * as route from '../../../app/api/competency/attempt/route.ts';

const tls={key:readFileSync(process.env.SC014_TEST_TLS_KEY),cert:readFileSync(process.env.SC014_TEST_TLS_CERT)};
const server=createServer(tls,async(req,res)=>{
 try {
  const path=new URL(req.url,'https://127.0.0.1').pathname;
  if(path==='/__isolated_redis_rest') {
   if(req.method!=='POST'||req.headers.authorization!=='Bearer '+process.env.COMPETENCY_BROKER_LIMITER_REST_TOKEN) {
    res.writeHead(403);res.end();return;
   }
   const chunks=[];for await(const part of req)chunks.push(part);
   const command=JSON.parse(Buffer.concat(chunks).toString());
   if(command[0]!=='EVAL'||command[2]!==2)throw Error('Invalid Redis fixture call');
   const raw=execFileSync('redis-cli',['-h','127.0.0.1','-p','6379','--raw',...command.map(String)],
    {encoding:'utf8',timeout:2000}).trim();
   if(!/^[01]$/.test(raw))throw Error('Invalid Redis fixture response');
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({result:Number(raw)}));return;
  }
  if(path!=='/api/competency/attempt'){res.writeHead(404);res.end();return;}
  const method=req.method||'GET';
  const request=new Request(process.env.COMPETENCY_BROKER_ORIGIN+path,{method,headers:req.headers,
   ...(method==='POST'?{body:req,duplex:'half'}:{})});
  const handler=route[method];
  const reply=handler?await handler(request):new Response(null,{status:405});
  for(const [name,value] of reply.headers)if(name!=='set-cookie')res.setHeader(name,value);
  const cookies=reply.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies);
  res.statusCode=reply.status;res.end(Buffer.from(await reply.arrayBuffer()));
 } catch { res.writeHead(503,{'cache-control':'no-store'});res.end('{"error":"unavailable"}'); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='https://127.0.0.1:'+server.address().port;
process.env.COMPETENCY_BROKER_ORIGIN=origin;
process.env.COMPETENCY_BROKER_LIMITER_REST_URL=origin+'/__isolated_redis_rest';
process.send({origin});
