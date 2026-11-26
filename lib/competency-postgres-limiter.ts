import type { SharedRateLimiter } from './competency-broker-limiter.ts';
import { verifyCompetencyGateway } from './competency-broker-role.ts';
import { competencyDiagnosticDetail, tagCompetencyDiagnostic } from './competency-broker-diagnostics.ts';
import type { CompetencyGatewayPool } from './competency-attempt-broker-runtime.ts';

/** Shared atomic database counter. No IP, capability or candidate data enters it. */
export function createPostgresSharedLimiter(pool:CompetencyGatewayPool,expectedUser:string):SharedRateLimiter {
 return {async consume(sourceHmac,windowId) {
  if(!/^[a-f0-9]{64}$/.test(sourceHmac)||!Number.isSafeInteger(windowId)||windowId<0)
   throw new Error('Invalid rate limit context');
  if(pool.waitingCount>=4)throw tagCompetencyDiagnostic(new Error('Limiter backpressure'),'pool_backpressure');
  let client;
  try{client=await pool.connect();}
  catch{throw tagCompetencyDiagnostic(new Error('Shared limiter unavailable'),'connect');}
  let destroy=false;
  try {
   await verifyCompetencyGateway(client,expectedUser,{postgresLimiter:true});
   await client.query('begin');
   await client.query('set local role competency_test_gateway');
   const result=(await client.query('select private.consume_competency_rate_limit($1,$2) as allowed',[sourceHmac,windowId])).rows[0]?.allowed;
   if(typeof result!=='boolean')throw new Error('Invalid rate limiter response');
   await client.query('commit');return result;
  }catch(error){
   destroy=true;try{await client.query('rollback');}catch{/* discard */}
   throw tagCompetencyDiagnostic(new Error('Shared limiter unavailable'),competencyDiagnosticDetail(error)??'rpc');
  }finally{client.release(destroy);}
 }};
}
