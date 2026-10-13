import {createHash,timingSafeEqual} from 'node:crypto';
import {digest,parseEnvelope} from './ledger.mjs';

const MAX_BODY_BYTES=2*1024*1024;
const MAX_RESPONSE_BYTES=4*1024*1024;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;
const keyId=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const receiptKeys=['kind','ledger_id','ledger_sequence','previous_ledger_hash','event_id','request_id','company_id','generation','request_sequence','previous_event_hash','phase','envelope_hash','boundary_hash','manifest_hash','reservation_key_id','reservation_proof','event_hash','key_id','signature'];
const exactKeys=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join() === [...keys].sort().join();
const tokenHash=value=>createHash('sha256').update(value).digest();
const positive=value=>Number.isSafeInteger(value)&&value>0;
const base64=value=>typeof value==='string'&&value.length>0&&value.length<=Math.ceil(1048576/3)*4&&Buffer.from(value,'base64').toString('base64')===value;
class RequestError extends Error {constructor(status){super('Request rejected');this.status=status;}}
function headerValues(req,name){
 const result=[];
 for(let i=0;i<(req.rawHeaders??[]).length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)result.push(req.rawHeaders[i+1]);
 return result;
}
function send(res,status,value){
 const encoded=JSON.stringify(value);
 if(Buffer.byteLength(encoded)>MAX_RESPONSE_BYTES)throw new Error('Response too large');
 res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','connection':'close'});
 res.end(encoded);
}
async function readBody(req,maxBodyBytes){
 const type=headerValues(req,'content-type'),encoding=headerValues(req,'content-encoding');
 if(type.length!==1||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type[0])||encoding.length)throw new RequestError(400);
 const lengths=headerValues(req,'content-length');
 if(lengths.length>1||(lengths.length===1&&!/^(0|[1-9][0-9]*)$/.test(lengths[0])))throw new RequestError(400);
 if(lengths.length&&Number(lengths[0])>maxBodyBytes)throw new RequestError(413);
 const bytes=await new Promise((resolve,reject)=>{
  const chunks=[];let size=0;
  const cleanup=()=>{req.off('data',onData);req.off('end',onEnd);req.off('error',onError);req.off('aborted',onAborted);};
  const onError=()=>{cleanup();reject(new RequestError(400));};
  const onAborted=()=>onError();
  const onData=chunk=>{size+=chunk.length;if(size>maxBodyBytes){cleanup();req.resume();reject(new RequestError(413));}else chunks.push(chunk);};
  const onEnd=()=>{cleanup();resolve(Buffer.concat(chunks));};
  req.on('data',onData);req.on('end',onEnd);req.on('error',onError);req.on('aborted',onAborted);
 });
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new RequestError(400);}
}
function validateAppend(value){
 if(!exactKeys(value,['eventId','envelopeText','envelopeHash','reservationKeyId','reservationProof'])||typeof value.eventId!=='string'||!uuid.test(value.eventId)||typeof value.envelopeText!=='string'||typeof value.envelopeHash!=='string'||!hash.test(value.envelopeHash)||typeof value.reservationKeyId!=='string'||!keyId.test(value.reservationKeyId)||!base64(value.reservationProof)||Buffer.from(value.reservationProof,'base64').length!==64)throw new RequestError(400);
 try{parseEnvelope(value.envelopeText);if(digest(value.envelopeText)!==value.envelopeHash)throw new Error();}catch{throw new RequestError(400);}
}
function validReceipt(value){
 return exactKeys(value,receiptKeys)&&value.kind==='erasure_event'&&['ledger_id','event_id','request_id','company_id'].every(k=>typeof value[k]==='string'&&uuid.test(value[k]))&&['ledger_sequence','request_sequence','generation'].every(k=>positive(value[k]))&&['envelope_hash','boundary_hash','manifest_hash','event_hash'].every(k=>typeof value[k]==='string'&&hash.test(value[k]))&&['previous_event_hash','previous_ledger_hash'].every(k=>value[k]===null||(typeof value[k]==='string'&&hash.test(value[k])))&&['authorized','cancelled','erasing','active_data_erased'].includes(value.phase)&&['key_id','reservation_key_id'].every(k=>typeof value[k]==='string'&&keyId.test(value[k]))&&['signature','reservation_proof'].every(k=>base64(value[k])&&Buffer.from(value[k],'base64').length===64);
}
function validEncrypted(value){
 return exactKeys(value,['key_id','iv','ciphertext','tag'])&&typeof value.key_id==='string'&&keyId.test(value.key_id)&&base64(value.iv)&&Buffer.from(value.iv,'base64').length===12&&base64(value.tag)&&Buffer.from(value.tag,'base64').length===16&&base64(value.ciphertext)&&value.ciphertext.length<=Math.ceil(1048576/3)*4&&Buffer.from(value.ciphertext,'base64').length<=1048576;
}
function pageParameters(query){
 const p=new URLSearchParams(query);
 if([...p.keys()].sort().join()!=='after,limit,through')throw new RequestError(400);
 const result={};for(const k of ['after','through','limit']){const value=p.get(k);if(!/^(0|[1-9][0-9]*)$/.test(value??''))throw new RequestError(400);result[k]=Number(value);if(!Number.isSafeInteger(result[k]))throw new RequestError(400);}
 // Bound BEFORE the database call: two maximum envelopes encode to <3 MiB.
 if(result.through<result.after||result.limit<1||result.limit>2)throw new RequestError(400);
 return result;
}
/** Separate ledger-only process. All adapters come from trusted operator config.
 * checkpointRegister.record(receipt) MUST durably advance an independent, monotonic
 * compare-and-set register outside both ledger and product database backups. An
 * older retry must verify its existing chain position without rolling back the
 * register. Resolution means durable coverage; failures must reject. This module
 * intentionally supplies no in-memory/file/database substitute for that store.
 * Configure TLS at the trusted ingress; never expose this HTTP handler directly.
 */
export function createLedgerService({ledger,readRecords,checkpointRegister,appendToken,readToken,maxBodyBytes=MAX_BODY_BYTES}={}){
 if(typeof ledger?.append!=='function'||typeof ledger?.checkpoint!=='function'||typeof readRecords!=='function'||typeof checkpointRegister?.record!=='function')throw new Error('Ledger service adapters required');
 if(!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<1||maxBodyBytes>MAX_BODY_BYTES)throw new Error('Invalid ledger service body limit');
 for(const token of [appendToken,readToken])if(typeof token!=='string'||!/^[\x21-\x7e]{32,4096}$/.test(token))throw new Error('Distinct strong service tokens required');
 const appendHash=tokenHash(appendToken),readHash=tokenHash(readToken);
 if(timingSafeEqual(appendHash,readHash))throw new Error('Distinct strong service tokens required');
 return async function ledgerService(req,res){
  try{
   const [path,query,...extra]=(req.url??'').split('?');
   if(extra.length)throw new RequestError(400);
   const write=req.method==='POST'&&path==='/v1/events';
   const checkpoint=req.method==='POST'&&path==='/v1/checkpoint';
   const records=req.method==='GET'&&path==='/v1/records';
   const health=req.method==='GET'&&path==='/healthz';
   if(!write&&!checkpoint&&!records&&!health)throw new RequestError(404);
   const auth=headerValues(req,'authorization');
   if(auth.length!==1||!/^Bearer [\x21-\x7e]{32,4096}$/.test(auth[0])||!timingSafeEqual(tokenHash(auth[0].slice(7)),write?appendHash:readHash))throw new RequestError(401);
   if(!records&&query!==undefined)throw new RequestError(400);
   if(health){send(res,200,{ok:true,production_ready:false});return;}
   if(records){
    const page=pageParameters(query??'');
    const rows=await readRecords(page);
    if(!Array.isArray(rows)||rows.length>page.limit||rows.length!==Math.min(page.limit,page.through-page.after))throw new Error('Invalid page');
    for(let i=0;i<rows.length;i++)if(!exactKeys(rows[i],['receipt','encrypted_envelope'])||!validReceipt(rows[i].receipt)||rows[i].receipt.ledger_sequence!==page.after+i+1||!validEncrypted(rows[i].encrypted_envelope))throw new Error('Invalid page');
    send(res,200,{records:rows});return;
   }
   const value=await readBody(req,maxBodyBytes);
   if(write){
    validateAppend(value);
    const receipt=await ledger.append(value);
    if(!validReceipt(receipt)||receipt.event_id!==value.eventId||receipt.envelope_hash!==value.envelopeHash)throw new Error('Invalid receipt');
    await checkpointRegister.record(receipt);
    send(res,200,receipt);return;
   }
   if(!exactKeys(value,['challenge'])||typeof value.challenge!=='string'||!uuid.test(value.challenge))throw new RequestError(400);
   const result=await ledger.checkpoint(value.challenge);
   if(!exactKeys(result,['kind','ledger_id','sequence','head_hash','challenge','event_hash','key_id','signature'])||result.kind!=='erasure_checkpoint'||!uuid.test(result.ledger_id??'')||!Number.isSafeInteger(result.sequence)||result.sequence<0||(result.sequence===0?result.head_hash!==null:!hash.test(result.head_hash??''))||result.challenge!==value.challenge||!hash.test(result.event_hash??'')||!keyId.test(result.key_id??'')||!base64(result.signature)||Buffer.from(result.signature,'base64').length!==64)throw new Error('Invalid checkpoint');
   send(res,200,result);
  }catch(error){
   if(!res.headersSent&&!res.destroyed){const status=error instanceof RequestError?error.status:503;send(res,status,{error:status===503?'service_unavailable':'request_rejected'});}
  }
 };
}
