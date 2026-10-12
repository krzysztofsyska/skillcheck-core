import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createLedgerService} from '../tools/erasure/service.mjs';
import {PostgresErasureLedger,digest,signReservationProof,verifyReplayCoverage} from '../tools/erasure/ledger.mjs';

const appendToken='append-test-'+ 'a'.repeat(40),readToken='read-test-'+ 'b'.repeat(40);
function envelope(){return {contract:'sc010-r3-v1',company_id:randomUUID(),request_id:randomUUID(),generation:1,candidate_ids:[randomUUID()],scope_kind:'candidate_record',resolution_revision:0,authorized_at:'2026-01-01T00:00:00Z',policy:{revision:1,rules:['candidate','assessment','screening','communication','audit','external','backup','exports'].map(data_class=>({data_class,trigger_event:'record_created',duration_days:90,hold_review_days:30}))},authorization:{kind:'owner',actor_id:randomUUID()},manifest_hash:'a'.repeat(64),schema_signature:'b'.repeat(64),external_resources:[],phase:'authorized',sequence:1,previous_phase:null,previous_event_hash:null,retention_until:'2027-01-01T00:00:00Z'};}
function payload(){const envelopeText=JSON.stringify(envelope());return {eventId:randomUUID(),envelopeText,envelopeHash:digest(envelopeText),reservationKeyId:'reservation-v1',reservationProof:Buffer.alloc(64).toString('base64')};}
async function server(t,overrides={}){
 const calls={append:0,checkpoint:0,records:0,register:0};
 const handler=createLedgerService({appendToken,readToken,ledger:{append:async()=>{calls.append++;throw Error('SECRET_DATABASE_PASSWORD');},checkpoint:async()=>{calls.checkpoint++;throw Error('SECRET_SIGNING_KEY');}},readRecords:async()=>{calls.records++;throw Error('SECRET_STORAGE_TOKEN');},checkpointRegister:{record:async()=>{calls.register++;throw Error('SECRET_REGISTER_TOKEN');}},...overrides});
 const http=createServer(handler);http.listen(0,'127.0.0.1');await once(http,'listening');
 t.after(()=>new Promise(resolve=>{http.close(resolve);http.closeAllConnections();}));
 const base=`http://127.0.0.1:${http.address().port}`;
 async function send(path,{token=readToken,method='GET',body,headers={}}={}){
  const response=await fetch(base+path,{method,headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  const text=await response.text();return {status:response.status,text,headers:response.headers,json:()=>JSON.parse(text)};
 }
 return {base,send,calls};
}
async function ledgerFixture(t){
 const db=new PGlite();await db.exec(await readFile(new URL('../tools/erasure/ledger.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const ledgerId=randomUUID(),encryptionKey=randomBytes(32),signing=generateKeyPairSync('ed25519'),reservation=generateKeyPairSync('ed25519');
 await db.query('insert into erasure_ledger.head(singleton,ledger_id) values(true,$1)',[ledgerId]);
 const verificationKeys={v1:signing.publicKey},encryptionKeys={v1:encryptionKey},reservationKeys={'reservation-v1':reservation.publicKey};
 const ledger=new PostgresErasureLedger({connect:async()=>({query:db.query.bind(db),end:async()=>{}}),ledgerId,encryptionKeyId:'v1',encryptionKey,signingKeyId:'v1',signingKey:signing.privateKey,verificationKeys,reservationKeys});
 const makePayload=()=>{const p=payload();return {...p,reservationProof:signReservationProof(p.envelopeHash,reservation.privateKey)};};
 const readRecords=async({after,through,limit})=>(await db.query('select receipt,encrypted_envelope from erasure_ledger.events where sequence>$1 and sequence<=$2 order by sequence limit $3',[after,through,limit])).rows;
 return {db,ledger,ledgerId,verificationKeys,encryptionKeys,reservationKeys,makePayload,readRecords};
}

test('R5 HTTP credentials are fail-closed and split append/read authority',async t=>{
 const {send,calls}=await server(t);
 for(const token of [null,'incorrect',appendToken])assert.equal((await send('/healthz',{token})).status,401);
 for(const path of ['/v1/checkpoint','/v1/records?after=0&through=1&limit=1'])assert.equal((await send(path,{token:appendToken,method:path.includes('checkpoint')?'POST':'GET',...(path.includes('checkpoint')?{body:{challenge:randomUUID()}}:{})})).status,401);
 assert.equal((await send('/v1/events',{token:readToken,method:'POST',body:payload()})).status,401);
 assert.deepEqual(calls,{append:0,checkpoint:0,records:0,register:0});
 const health=await send('/healthz');assert.equal(health.status,200);assert.deepEqual(health.json(),{ok:true,production_ready:false});assert.match(health.headers.get('cache-control'),/no-store/);
 for(const options of [{appendToken:'short'},{appendToken:readToken},{readToken:'a'.repeat(32)+'\n'}])assert.throws(()=>createLedgerService({ledger:{append(){},checkpoint(){}},readRecords(){},checkpointRegister:{record(){}},appendToken,readToken,...options}));
});

test('R5 authenticates without waiting for an incomplete body and rejects duplicate authorization',async t=>{
 const {base,calls}=await server(t);const url=new URL(base);
 async function incomplete(headers){return new Promise((resolve,reject)=>{
  const req=request({hostname:url.hostname,port:url.port,path:'/v1/events',method:'POST',headers},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{req.destroy();resolve({status:res.statusCode,text});});});
  req.on('error',reject);req.setTimeout(1500,()=>req.destroy(Error('Authentication waited for attacker body')));req.flushHeaders();
 });}
 assert.equal((await incomplete({'content-type':'application/json','content-length':'1000000'})).status,401);
 assert.equal((await incomplete(['Host',url.host,'Authorization',`Bearer ${appendToken}`,'Authorization',`Bearer ${appendToken}`,'Content-Length','1000000'])).status,401);
 assert.equal(calls.append,0);
});

test('R5 body limits and exact request contracts reject before touching persistence',async t=>{
 const {send,calls}=await server(t,{maxBodyBytes:4096});
 for(const body of ['{','null','[]',{}, {...payload(),email:'private@example.test'}, {...payload(),envelopeHash:'0'.repeat(64)}])assert.equal((await send('/v1/events',{method:'POST',token:appendToken,body})).status,400);
 const p=payload();delete p.reservationProof;assert.equal((await send('/v1/events',{method:'POST',token:appendToken,body:p})).status,400);
 assert.equal((await send('/v1/events',{method:'POST',token:appendToken,body:'x'.repeat(4097)})).status,413);
 assert.equal((await send('/v1/events',{method:'POST',token:appendToken,body:'é'.repeat(2050)})).status,413);
 for(const body of [{},{challenge:'not-a-uuid'},{challenge:randomUUID(),extra:true}])assert.equal((await send('/v1/checkpoint',{method:'POST',body})).status,400);
 assert.deepEqual(calls,{append:0,checkpoint:0,records:0,register:0});
});

test('R5 routes, methods and pagination never fall through to a privileged operation',async t=>{
 const {send,calls}=await server(t);
 for(const [path,method] of [['/','GET'],['/v1/events','GET'],['/v1/events','DELETE'],['/healthz','POST'],['/v1/checkpoint','GET'],['/v1/records','POST']])assert.equal((await send(path,{method,token:appendToken})).status,404);
 for(const query of ['','?after=-1&through=1&limit=1','?after=0&through=1&limit=101','?after=0&through=1&limit=0','?after=0&through=1&limit=1.5','?after=0&through=9007199254740992&limit=1','?after=2&through=1&limit=1','?after=0&through=1&limit=1&email=private','?after=0&after=1&through=2&limit=1'])assert.equal((await send('/v1/records'+query)).status,400,query);
 assert.deepEqual(calls,{append:0,checkpoint:0,records:0,register:0});
});

test('R5 dependency errors do not disclose database, signing or register secrets',async t=>{
 const {send}=await server(t);
 for(const [path,options] of [['/v1/events',{method:'POST',token:appendToken,body:payload()}],['/v1/checkpoint',{method:'POST',body:{challenge:randomUUID()}}],['/v1/records?after=0&through=1&limit=1',{}]]){
  const result=await send(path,options);assert.equal(result.status,503);assert.doesNotMatch(result.text,/SECRET|postgres:|stack|at /);assert.match(result.headers.get('cache-control'),/no-store/);
 }
});

test('R5 durable register gates receipt; outage retry persists one signed encrypted event',async t=>{
 const f=await ledgerFixture(t);let registerCalls=0,watermark=null;const observed=[];
 const checkpointRegister={record:async receipt=>{registerCalls++;const count=Number((await f.db.query('select count(*) as count from erasure_ledger.events')).rows[0].count);observed.push(count);if(registerCalls===1)throw Error('SECRET_REGISTER_PASSWORD');watermark={ledger_id:receipt.ledger_id,sequence:receipt.ledger_sequence,event_hash:receipt.event_hash};}};
 const {send}=await server(t,{ledger:f.ledger,readRecords:f.readRecords,checkpointRegister});const p=f.makePayload();
 const failed=await send('/v1/events',{method:'POST',token:appendToken,body:p});assert.equal(failed.status,503);assert.doesNotMatch(failed.text,/SECRET|signature|event_hash/);assert.equal(watermark,null);
 const retry=await send('/v1/events',{method:'POST',token:appendToken,body:p});assert.equal(retry.status,200);const receipt=retry.json();assert.equal(receipt.event_id,p.eventId);assert.equal(receipt.ledger_sequence,1);assert.deepEqual(observed,[1,1]);assert.equal(watermark.event_hash,receipt.event_hash);
 const again=await send('/v1/events',{method:'POST',token:appendToken,body:p});assert.deepEqual(again.json(),receipt);
 const rows=await f.readRecords({after:0,through:1,limit:100});assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(JSON.parse(p.envelopeText).candidate_ids[0]));
 const challenge=randomUUID(),checkpoint=(await send('/v1/checkpoint',{method:'POST',body:{challenge}})).json();
 const coverage={records:rows,checkpoint,challenge,ledgerId:f.ledgerId,minimumWatermark:watermark,verificationKeys:f.verificationKeys,encryptionKeys:f.encryptionKeys,reservationKeys:f.reservationKeys};assert.equal(verifyReplayCoverage(coverage).length,1);
 const freshChallenge=randomUUID(),fresh=(await send('/v1/checkpoint',{method:'POST',body:{challenge:freshChallenge}})).json();assert.equal(fresh.challenge,freshChallenge);assert.notEqual(fresh.event_hash,checkpoint.event_hash);assert.throws(()=>verifyReplayCoverage({...coverage,checkpoint:fresh}));
 const changed=f.makePayload();changed.eventId=p.eventId;assert.equal((await send('/v1/events',{method:'POST',token:appendToken,body:changed})).status,503);assert.equal((await f.readRecords({after:0,through:10,limit:100})).length,1);
});

test('R5 record pagination returns bounded encrypted pages usable for full signed replay',async t=>{
 const f=await ledgerFixture(t),queries=[];let watermark;
 const {send}=await server(t,{ledger:f.ledger,readRecords:args=>{queries.push(args);return f.readRecords(args);},checkpointRegister:{record:async r=>{watermark={ledger_id:r.ledger_id,sequence:r.ledger_sequence,event_hash:r.event_hash};}}});
 for(let i=0;i<3;i++)assert.equal((await send('/v1/events',{method:'POST',token:appendToken,body:f.makePayload()})).status,200);
 const first=await send('/v1/records?after=0&through=3&limit=2'),second=await send('/v1/records?after=2&through=3&limit=2');assert.equal(first.status,200);assert.equal(second.status,200);
 const records=[...first.json().records,...second.json().records];assert.deepEqual(records.map(r=>r.receipt.ledger_sequence),[1,2,3]);assert.deepEqual(queries,[{after:0,through:3,limit:2},{after:2,through:3,limit:2}]);
 for(const row of records)assert.deepEqual(Object.keys(row).sort(),['encrypted_envelope','receipt']);
 const challenge=randomUUID(),checkpoint=(await send('/v1/checkpoint',{method:'POST',body:{challenge}})).json();assert.equal(verifyReplayCoverage({records,checkpoint,challenge,ledgerId:f.ledgerId,minimumWatermark:watermark,verificationKeys:f.verificationKeys,encryptionKeys:f.encryptionKeys,reservationKeys:f.reservationKeys}).length,3);
});
