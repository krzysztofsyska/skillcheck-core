import type { SharedRateLimiter } from './competency-broker-limiter.ts';
import { verifyCompetencyGateway } from './competency-broker-role.ts';
import type { CompetencyGatewayPool } from './competency-attempt-broker-runtime.ts';

/** Shared atomic database counter. No IP, capability or candidate data enters it. */
export function createPostgresSharedLimiter(pool:CompetencyGatewayPool,expectedUser:string):SharedRateLimiter {
 return {async consume(sourceHmac,windowId) {
  if(!/^[a-f0-9]{64}$/.test(sourceHmac)||!Number.isSafeInteger(windowId)||windowId<0)
   throw new Error('Invalid rate limit context');
  if(pool.waitingCount>=4)throw new Error('Limiter backpressure');
  const client=await pool.connect();let destroy=false;
  try {
   await verifyCompetencyGateway(client,expectedUser,{postgresLimiter:true});
   await client.query('begin');
   await client.query('set local role competency_test_gateway');
   const result=(await client.query('select private.consume_competency_rate_limit($1,$2) as allowed',[sourceHmac,windowId])).rows[0]?.allowed;
   if(typeof result!=='boolean')throw new Error('Invalid rate limiter response');
   await client.query('commit');return result;
  }catch{
   destroy=true;try{await client.query('rollback');}catch{/* discard */}
   throw new Error('Shared limiter unavailable');
  }finally{client.release(destroy);}
 }};
}
