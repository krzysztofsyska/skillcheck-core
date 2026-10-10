import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire,Module} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as helpers from '../lib/erasure-preview.ts';
const dir=new URL('../app/dashboard/[companyId]/candidates/[candidateId]/retention/',import.meta.url);
function load(file,mocks){const path=new URL(file,dir).pathname;const mod=new Module(path);mod.filename=path;mod.paths=Module._nodeModulePaths(new URL('../',import.meta.url).pathname);const require=createRequire(path);mod.require=id=>id in mocks?mocks[id]:require(id);mod._compile(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020}}).outputText,path);return mod.exports;}
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('policy demands explicit periods and validates enabled categories',()=>{const f=new FormData();assert.throws(()=>helpers.parseRules(f));f.set('enabled_candidate','on');f.set('trigger_candidate','record_created');assert.throws(()=>helpers.parseRules(f));f.set('duration_candidate','30');f.set('hold_candidate','7');assert.deepEqual(helpers.parseRules(f),[{data_class:'candidate',trigger_event:'record_created',duration_days:30,hold_review_days:7}]);f.set('duration_candidate','0');assert.throws(()=>helpers.parseRules(f));});
test('person scope requires explicit confirmation and deduplicates anchor',()=>{const f=new FormData();f.append('candidate_ids',uuid(1));assert.throws(()=>helpers.parseSubject(f,uuid(1)));f.set('confirmed','on');assert.deepEqual(helpers.parseSubject(f,uuid(1)),[uuid(1)]);f.append('candidate_ids','malformed');assert.throws(()=>helpers.parseSubject(f,uuid(1)));});
test('owner UI renders explicit consent, empty durations, preview only',()=>{
 const actions={saveRetentionPolicy(){},confirmSubject(){},previewErasure(){}};
 const forms=load('forms.tsx',{'./actions':actions,'../../../../../../lib/erasure-preview':helpers});
 const props={companyId:uuid(1),candidateId:uuid(2),revision:0,rules:[],candidates:[{id:uuid(3),first_name:'Fikcyjna',last_name:'Osoba'}]};
 const html=renderToStaticMarkup(React.createElement(React.Fragment,null,React.createElement(forms.PolicyForm,props),React.createElement(forms.SubjectForm,props),React.createElement(forms.PreviewForm,props)));
 assert.match(html,/Podgląd nie usuwa danych/);assert.match(html,/Potwierdzam, że wszystkie/);assert.match(html,/Fikcyjna/);assert.doesNotMatch(html,/checked=""|value="30"|Usuń teraz/);
});
function actionFixture(owner=true){const calls=[];let resolution={id:uuid(9),revision:2,owner_current:true};const client={from:()=>({select(){return this},eq(){return this},async maybeSingle(){return {data:{id:uuid(2)},error:null}}}),async rpc(name,args){calls.push({name,args});if(name==='get_erasure_subject_resolution')return {data:resolution,error:null};if(name==='preview_candidate_erasure')return {data:{scope_kind:args.scope_kind,candidate_count:1,counts:{candidate:1},blockers:['execution_not_implemented'],policy_revision:1,resolution_revision:2,manifest_hash:'hash',schema_signature:'sig',generated_at:new Date().toISOString(),expires_at:new Date(Date.now()+300000).toISOString()},error:null};return {data:uuid(8),error:null}}};const actions=load('actions.ts',{'../../../../../../lib/company-access':{companyAccess:async()=>({client,company:{owner_id:uuid(1)},user:{id:owner?uuid(1):uuid(7)}})},'../../../../../../lib/erasure-preview':helpers});return {actions,calls,client,setResolution:r=>resolution=r};}
test('nonowner cannot invoke any mutation or preview RPC',async()=>{const f=actionFixture(false);for(const name of ['saveRetentionPolicy','confirmSubject','previewErasure'])assert.ok((await f.actions[name](uuid(1),uuid(2),{},new FormData())).error);assert.equal(f.calls.length,0)});
test('person preview resolves ID on server and ignores forged client resolution',async()=>{const f=actionFixture(),form=new FormData();form.set('scope_kind','confirmed_subject');form.set('resolution_id',uuid(666));const result=await f.actions.previewErasure(uuid(1),uuid(2),{},form);assert.ok(result.preview);assert.equal(f.calls[1].args.resolution_id,uuid(9));assert.deepEqual(f.calls.map(c=>c.name),['get_erasure_subject_resolution','preview_candidate_erasure']);});
test('stale owner confirmation and missing migration cannot produce success',async()=>{const f=actionFixture(),form=new FormData();form.set('scope_kind','confirmed_subject');f.setResolution({id:uuid(9),owner_current:false});assert.ok((await f.actions.previewErasure(uuid(1),uuid(2),{},form)).error);assert.equal(f.calls.length,1);form.set('scope_kind','candidate_record');f.client.rpc=async()=>({data:null,error:{code:'PGRST202',message:'PRIVATE_ERROR'}});const result=await f.actions.previewErasure(uuid(1),uuid(2),{},form);assert.match(result.error,/nie jest jeszcze dostępny/);assert.ok(!result.preview);assert.doesNotMatch(result.error,/PRIVATE/)});
test('malformed preview is rejected instead of rendering success',()=>{assert.throws(()=>helpers.parsePreview({counts:{candidate:-1}}));});
test('saved subject scope survives reload and every manifest count has a clear label',()=>{
 const forms=load('forms.tsx',{'./actions':{saveRetentionPolicy(){},confirmSubject(){},previewErasure(){}},'../../../../../../lib/erasure-preview':helpers});
 const html=renderToStaticMarkup(React.createElement(forms.SubjectForm,{companyId:uuid(1),candidateId:uuid(2),revision:3,selectedIds:[uuid(2),uuid(3)],candidates:[{id:uuid(3),first_name:'Wybrana',last_name:'Osoba'}]}));
 assert.match(html,/checked=""/);
 const migration=readFileSync(new URL('../supabase/migrations/20261010190255_candidate_retention_preview.sql',import.meta.url),'utf8');
 for(const match of migration.matchAll(/select '(public\.[a-z_]+|private\.[a-z_]+)',t\./g))assert.ok(helpers.previewCountLabels[match[1]],match[1]);
});
test('request key survives response loss and rotates only on changed payload/revision',()=>{
 const form=new FormData();form.set('revision','0');form.set('duration_candidate','30');form.set('request_key','');let calls=0;const generate=()=>uuid(++calls);
 const first=helpers.stableRequestKey(form,null,generate);form.set('request_key',first.key);
 assert.deepEqual(helpers.stableRequestKey(form,first,generate),first);assert.equal(calls,1);
 form.set('duration_candidate','31');const changed=helpers.stableRequestKey(form,first,generate);assert.notEqual(changed.key,first.key);
 form.set('revision','1');assert.notEqual(helpers.stableRequestKey(form,changed,generate).key,changed.key);
});
test('mutations reuse validated client request key without trusting it as authorization',async()=>{
 const f=actionFixture(),form=new FormData();form.set('revision','0');form.set('confirmed','on');form.set('request_key',uuid(40));
 await f.actions.confirmSubject(uuid(1),uuid(2),{},form);await f.actions.confirmSubject(uuid(1),uuid(2),{},form);
 assert.equal(f.calls.length,2);assert.equal(f.calls[0].args.request_key,uuid(40));assert.equal(f.calls[1].args.request_key,uuid(40));
 form.set('request_key','malformed');assert.ok((await f.actions.confirmSubject(uuid(1),uuid(2),{},form)).error);assert.equal(f.calls.length,2);
});
test('saved offpage selection has hidden submitted IDs and links distinguish namesakes',()=>{
 const forms=load('forms.tsx',{'./actions':{saveRetentionPolicy(){},confirmSubject(){},previewErasure(){},searchSubjectCandidates(){}},'../../../../../../lib/erasure-preview':helpers});
 const html=renderToStaticMarkup(React.createElement(forms.SubjectForm,{companyId:uuid(1),candidateId:uuid(2),revision:3,selectedIds:[uuid(50)],candidates:[{id:uuid(3),first_name:'Jan',last_name:'Kowalski'},{id:uuid(4),first_name:'Jan',last_name:'Kowalski'}]}));
 assert.match(html,new RegExp(`name="candidate_ids" value="${uuid(50)}"`));
 for(const id of [uuid(3),uuid(4),uuid(50)])assert.ok(html.includes(`/candidates/${id}`));
});
test('candidate search is bounded tenant-filtered keyset pagination and owner-only',async()=>{
 const f=actionFixture(),queries=[];f.client.from=()=>{const calls=[];const q={select(v){calls.push(['select',v]);return this},eq(k,v){calls.push(['eq',k,v]);return this},order(v){calls.push(['order',v]);return this},limit(v){calls.push(['limit',v]);return this},ilike(k,v){calls.push(['ilike',k,v]);return this},gt(k,v){calls.push(['gt',k,v]);return this},async maybeSingle(){return {data:{id:uuid(2)},error:null}},then(resolve){queries.push(calls);return Promise.resolve({data:Array.from({length:26},(_,i)=>({id:uuid(i+10),first_name:'Jan',last_name:'Kowalski'})),error:null}).then(resolve)}};return q};
 const result=await f.actions.searchSubjectCandidates(uuid(1),uuid(2),'Kow%',uuid(8));
 assert.equal(result.candidates.length,25);assert.equal(result.next,uuid(34));assert.ok(queries[0].some(x=>x[0]==='limit'&&x[1]===26));assert.ok(queries[0].some(x=>x[0]==='eq'&&x[1]==='company_id'&&x[2]===uuid(1)));assert.ok(queries[0].some(x=>x[0]==='gt'&&x[2]===uuid(8)));assert.ok(queries[0].some(x=>x[0]==='ilike'&&x[2]==='Kow\\%%'));
 const denied=actionFixture(false);assert.ok((await denied.actions.searchSubjectCandidates(uuid(1),uuid(2),'',null)).error);
});
test('client action wrapper passes stable key in actual FormData before server serialization',async()=>{
 const callbacks=[],received=[];
 const forms=load('forms.tsx',{'react':{...React,useActionState(callback){callbacks.push(callback);return [{},()=>{},false]}},'./actions':{async saveRetentionPolicy(_company,_candidate,_state,form){received.push(form.get('request_key'));throw Error('NETWORK_LOST')}},'../../../../../../lib/erasure-preview':helpers});
 renderToStaticMarkup(React.createElement(forms.PolicyForm,{companyId:uuid(1),candidateId:uuid(2),revision:0,rules:[]}));
 const data=()=>{const f=new FormData();f.set('revision','0');f.set('duration_candidate','30');return f};
 await callbacks[0]({},data());await callbacks[0]({},data());
 assert.match(received[0],/^[0-9a-f-]{36}$/);assert.equal(received[0],received[1]);
 const changed=data();changed.set('revision','1');await callbacks[0]({},changed);assert.notEqual(received[2],received[1]);
});
test('successful revision survives later returned error and transport failure for retry',async()=>{
 const callbacks=[],received=[];let attempt=0;
 const forms=load('forms.tsx',{'react':{...React,useActionState(cb){callbacks.push(cb);return [{},()=>{},false]}},'./actions':{async saveRetentionPolicy(_c,_d,_s,form){received.push([form.get('revision'),form.get('request_key')]);attempt++;if(attempt===1)return {saved:'ok',revision:1};if(attempt===2)return {error:'Temporary error'};throw Error('NETWORK_LOST')}},'../../../../../../lib/erasure-preview':helpers});
 renderToStaticMarkup(React.createElement(forms.PolicyForm,{companyId:uuid(1),candidateId:uuid(2),revision:0,rules:[]}));
 const data=rev=>{const f=new FormData();f.set('revision',String(rev));f.set('duration_candidate','30');return f};
 const ok=await callbacks[0]({},data(0));const error=await callbacks[0](ok,data(ok.revision));assert.equal(error.revision,1);assert.ok(!error.saved);
 const lost=await callbacks[0](error,data(error.revision));assert.equal(lost.revision,1);assert.ok(!lost.saved);
 await callbacks[0](lost,data(lost.revision));assert.deepEqual(received[1],received[2]);assert.deepEqual(received[2],received[3]);
});
