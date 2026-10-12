import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createServiceBackend} from '../tools/erasure/service-backend.mjs';
import {startLedgerService} from '../tools/erasure/serve.mjs';

const ledgerId='10000000-0000-0000-0000-000000000001';
const signing=generateKeyPairSync('ed25519'),reservation=generateKeyPairSync('ed25519');
const state={role:'erasure_ledger_service',rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,memberships:0,schema_create:false,owns_objects:false,events_select:true,events_insert:true,events_extra:false,events_column_extra:false,head_select:true,head_update:true,head_extra:false};
function fixture({privileges={},head=[{ledger_id:ledgerId}],records=[],queryFailure=false}={}){
 const calls=[],connections=[];
 const connect=async()=>{
  const connection={ended:0,query:async(sql,params)=>{
   calls.push({sql,params});
   if(sql.includes('from pg_roles'))return {rows:[{...state,...privileges}]};
   if(sql==='select ledger_id from erasure_ledger.head where singleton=true')return {rows:head};
   if(queryFailure)throw new Error('PRIVATE_DATABASE_CONNECTION_DETAIL');
   return {rows:records};
  },end:async()=>{connection.ended++;}};
  connections.push(connection);return connection;
 };
 return {calls,connections,options:{connect,ledgerId,encryptionKeyId:'encryption-1',encryptionKey:randomBytes(32),signingKeyId:'signing-1',signingKey:signing.privateKey,verificationKeys:{'signing-1':signing.publicKey},reservationKeys:{'reservation-1':reservation.publicKey}}};
}

test('backend accepts only the expected least-privilege role and closes startup connection',async()=>{
 const f=fixture();const backend=await createServiceBackend(f.options);
 assert.equal(typeof backend.ledger.append,'function');assert.equal(typeof backend.readRecords,'function');
 assert.equal(f.connections.length,1);assert.equal(f.connections[0].ended,1);
 assert.match(f.calls[0].sql,/pg_auth_members/);assert.match(f.calls[0].sql,/has_table_privilege/);
});

test('backend fails closed for wrong role, role memberships, administrative flags, object ownership, and excess/missing grants',async t=>{
 const rejected=[{role:'postgres'},{role:'service_role'},{memberships:1},{memberships:'0'},
  ...['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','schema_create','owns_objects','events_extra','events_column_extra','head_extra'].map(k=>({[k]:true})),
  ...['events_select','events_insert','head_select','head_update'].map(k=>({[k]:false})),{events_extra:null}];
 for(const privileges of rejected)await t.test(JSON.stringify(privileges),async()=>{
  const f=fixture({privileges});await assert.rejects(createServiceBackend(f.options),/Wrong ledger service privileges/);
  assert.equal(f.connections[0].ended,1);assert.equal(f.calls.length,1);
 });
});

test('backend rejects wrong or absent ledger identity before serving and closes connection',async t=>{
 for(const head of [[],[{ledger_id:'20000000-0000-0000-0000-000000000001'}],[{ledger_id:ledgerId},{ledger_id:ledgerId}]])await t.test(JSON.stringify(head),async()=>{
  const f=fixture({head});await assert.rejects(createServiceBackend(f.options),/Wrong ledger database/);assert.equal(f.connections[0].ended,1);
 });
});

test('backend validates Ed25519 signing identity and public-only reservation authority before connecting',async t=>{
 const another=generateKeyPairSync('ed25519'),ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const rejected=[
  {verificationKeys:{'signing-1':another.publicKey}},
  {verificationKeys:{other:signing.publicKey}},
  {signingKey:ec.privateKey,verificationKeys:{'signing-1':ec.publicKey}},
  {reservationKeys:{'reservation-1':reservation.privateKey}},
  {reservationKeys:{'reservation-1':reservation.privateKey.export({type:'pkcs8',format:'pem'})}},
  {reservationKeys:{'reservation-1':ec.publicKey}},
  {verificationKeys:{'signing-1':signing.privateKey}},
  {reservationKeys:{}},{encryptionKey:Buffer.alloc(31)}
 ];
 for(const [index,patch] of rejected.entries())await t.test(`invalid key configuration ${index}`,async()=>{
  const f=fixture();await assert.rejects(createServiceBackend({...f.options,...patch}));assert.equal(f.connections.length,0);
 });
 const f=fixture();await createServiceBackend({...f.options,signingKey:signing.privateKey.export({type:'pkcs8',format:'pem'}),verificationKeys:{'signing-1':signing.publicKey.export({type:'spki',format:'pem'})},reservationKeys:{'reservation-1':reservation.publicKey.export({type:'spki',format:'pem'})}});
 assert.equal(f.connections[0].ended,1);
});

test('bounded records adapter parameterizes range, rejects unbounded input before connecting, and closes after success/error',async()=>{
 const rows=[{receipt:{ledger_sequence:2},encrypted_envelope:{ciphertext:'opaque'}}];
 const f=fixture({records:rows});const backend=await createServiceBackend(f.options);
 assert.deepEqual(await backend.readRecords({after:1,through:9,limit:2}),rows);
 assert.deepEqual(f.calls.at(-1).params,[1,9,2]);
 assert.match(f.calls.at(-1).sql,/sequence>\$1 and sequence<=\$2 order by sequence limit \$3/);
 assert.equal(f.connections.at(-1).ended,1);
 const count=f.connections.length;
 for(const range of [{after:-1,through:1,limit:1},{after:2,through:1,limit:1},{after:0,through:1,limit:101},{after:0,through:1,limit:0},{after:0,through:Infinity,limit:1},{after:0,through:1.5,limit:1},{after:'0',through:1,limit:1}])await assert.rejects(backend.readRecords(range),/Invalid record range/);
 assert.equal(f.connections.length,count);
 const bad=fixture({queryFailure:true});const badBackend=await createServiceBackend(bad.options);
 await assert.rejects(badBackend.readRecords({after:0,through:1,limit:1}));assert.equal(bad.connections.at(-1).ended,1);
});

test('service launcher binds only loopback, authenticates health, and refuses missing independent register before connecting',async()=>{
 const f=fixture(),config={ledgerOptions:f.options,appendToken:'synthetic-append-token-000000000000000',readToken:'synthetic-reader-token-000000000000000',checkpointRegister:{record:async()=>{}}};
 await assert.rejects(startLedgerService({...config,checkpointRegister:undefined},{port:0}),/Independent checkpoint register required/);
 assert.equal(f.connections.length,0);
 const server=await startLedgerService(config,{port:0});
 try{
  const address=server.address();assert.equal(address.address,'127.0.0.1');assert.ok(address.port>0);
  assert.equal(server.requestTimeout,15000);assert.equal(server.headersTimeout,10000);
  const response=await fetch(`http://127.0.0.1:${address.port}/healthz`,{headers:{authorization:`Bearer ${config.readToken}`}});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,production_ready:false});
 }finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});


test('reservation authority cannot reuse ledger signing key, including under another ID or PEM encoding',async()=>{
 for(const reservationKeys of [
  {'different-reservation-id':signing.publicKey},
  {'different-reservation-id':signing.publicKey.export({type:'spki',format:'pem'})},
  {'reservation-1':reservation.publicKey,'hidden-reused-key':signing.publicKey}
 ]){
  const f=fixture();
  await assert.rejects(createServiceBackend({...f.options,reservationKeys}),/Reservation and ledger keys must be independent/);
  assert.equal(f.connections.length,0);
 }
});

test('real PostgreSQL column-level UPDATE bypasses table-grant check but backend startup rejects it',async()=>{
 const db=new PGlite();let closedConnections=0;
 try{
  await db.exec(await readFile(new URL('../tools/erasure/ledger.sql',import.meta.url),'utf8'));
  await db.exec(`create role erasure_ledger_service login nosuperuser nobypassrls nocreatedb nocreaterole;
   grant usage on schema erasure_ledger to erasure_ledger_service;
   grant select,insert on erasure_ledger.events to erasure_ledger_service;
   grant select,update on erasure_ledger.head to erasure_ledger_service;`);
  await db.query('insert into erasure_ledger.head(singleton,ledger_id) values(true,$1)',[ledgerId]);
  const f=fixture();
  const connect=async()=>{
   await db.exec('set role erasure_ledger_service');
   return {query:db.query.bind(db),end:async()=>{closedConnections++;await db.exec('reset role');}};
  };
  await createServiceBackend({...f.options,connect});assert.equal(closedConnections,1);
  await db.exec('grant update(receipt) on erasure_ledger.events to erasure_ledger_service');
  const grants=(await db.query(`select
   has_table_privilege('erasure_ledger_service','erasure_ledger.events','UPDATE') as table_update,
   has_any_column_privilege('erasure_ledger_service','erasure_ledger.events','UPDATE') as column_update`)).rows[0];
  assert.deepEqual(grants,{table_update:false,column_update:true});
  await assert.rejects(createServiceBackend({...f.options,connect}),/Wrong ledger service privileges/);
  assert.equal(closedConnections,2);
 }finally{await db.close();}
});
