#!/usr/bin/env node
import {createServer} from 'node:http';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLedgerService} from './service.mjs';
import {createServiceBackend} from './service-backend.mjs';

export async function startLedgerService(config,{port=8787}={}){
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
 if(!config?.checkpointRegister||typeof config.checkpointRegister.record!=='function')throw new Error('Independent checkpoint register required');
 const backend=await createServiceBackend(config.ledgerOptions);
 const handler=createLedgerService({...backend,checkpointRegister:config.checkpointRegister,appendToken:config.appendToken,readToken:config.readToken});
 const server=createServer({maxHeaderSize:8192,requestTimeout:15000,headersTimeout:10000,keepAliveTimeout:5000},handler);
 server.maxRequestsPerSocket=100;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--config'||!isAbsolute(args[1]))throw new Error('Absolute operator config required');
  const config=await import(pathToFileURL(args[1]).href);
  const server=await startLedgerService(config);
  process.stdout.write(JSON.stringify({service:'erasure-ledger',listening:'127.0.0.1:8787',production_ready:false})+'\n');
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),20000).unref();});
 }catch{process.stderr.write('ERASURE_SERVICE_START_FAILED\n');process.exitCode=1;}
}
