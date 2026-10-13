#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {runRetentionScheduleTick,inspectErasureLedgerHealth,replayVerifiedLedger,newRestoreChallenge} from './runtime.mjs';

/** The config module is trusted operator code outside the repository. It exports
 * factories/keys, never supplies an HTTP user-controlled configuration. */
export async function runErasureCommand(args,{loadConfig=async path=>import(pathToFileURL(resolve(path)).href)}={}){
 const [command,...options]=args;
 if(!['tick','health','drill'].includes(command))throw new Error('Invalid erasure command');
 const flags={};
 for(let i=0;i<options.length;i++){
  const option=options[i];
  if(!['--config','--limit','--isolated'].includes(option)||Object.hasOwn(flags,option))throw new Error('Invalid erasure command options');
  if(option==='--isolated')flags[option]=true;
  else{if(!options[i+1]||options[i+1].startsWith('--'))throw new Error('Missing erasure command option');flags[option]=options[++i];}
 }
 if(!flags['--config']||(command!=='tick'&&flags['--limit'])||(command!=='drill'&&flags['--isolated'])||(command==='drill'&&!flags['--isolated']))throw new Error('Invalid erasure command options');
 if(command==='tick'&&flags['--limit']&&!/^(?:[1-9]|[1-9][0-9]|100)$/.test(flags['--limit']))throw new Error('Invalid scheduler batch limit');
 try{
  const config=await loadConfig(flags['--config']);
  if(command==='tick')return {command,...await runRetentionScheduleTick({connect:config.schedulerConnect,batchLimit:flags['--limit']?Number(flags['--limit']):25}),execution_completed:false};
  if(command==='health')return {command,...await inspectErasureLedgerHealth(config.ledgerHealth??{})};
  // Explicit drill writes only through the existing isolated restore ingress.
  // SQL independently enforces isolation; this flag cannot substitute for it.
  const inputs=config.ledgerHealth,challenge=newRestoreChallenge();
  const [checkpoint,minimumWatermark]=await Promise.all([inputs.getCheckpoint(challenge),inputs.getMinimumWatermark()]);
  // A drill requires the independently retained register to cover the exact
  // live checkpoint, not merely a lower bound accepted by recovery verification.
  if(!minimumWatermark||minimumWatermark.sequence!==checkpoint.sequence||minimumWatermark.event_hash!==checkpoint.head_hash)throw new Error('Unreconciled drill watermark');
  const records=await inputs.getRecords(checkpoint.sequence);
  const result=await replayVerifiedLedger({...inputs,records,checkpoint,minimumWatermark,challenge,connect:config.restoreConnect});
  return {command,replayed:result.replayed,verified_events:result.verifiedEvents,checkpoint:result.checkpoint,production_ready:false,isolation_released:false};
 }catch{throw new Error('ERASURE_COMMAND_FAILED');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const result=await runErasureCommand(process.argv.slice(2));process.stdout.write(JSON.stringify(result)+'\n');if(result.command==='health'&&!result.ledger_verified)process.exitCode=1;}
 catch{process.stderr.write('ERASURE_COMMAND_FAILED\n');process.exitCode=1;}
}
