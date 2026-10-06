import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { httpWorld } from './http-world.mjs';

test('two independent processes use the live GitHub CAS path; one owns intent',async()=>{
 const w=httpWorld();
 const server=createServer(async(req,res)=>{
  try {let body='';for await(const chunk of req)body+=chunk;
   const response=await w.fetch(`https://api.github.com${req.url}`,{method:req.method,body:body||undefined});
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(500);res.end(JSON.stringify({message:error.message}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 const run=id=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['tests/agent-pipeline/live-race-worker.mjs',url,id]);let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('exit',code=>code?reject(Error(err)):resolve(out));});
 try {const results=await Promise.all([run('a'),run('b')]);assert.deepEqual(results.sort(),['conflict','winner']);assert.equal(Object.keys(w.projection()).length,1);}
 finally {await new Promise(resolve=>server.close(resolve));}
});
