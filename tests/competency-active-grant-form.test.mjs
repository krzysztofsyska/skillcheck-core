import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import React from 'react';
import jsxRuntime from 'react/jsx-runtime';
import TestRenderer from 'react-test-renderer';
import ts from 'typescript';
import {activeBoot} from './helpers/competency-active-fixture.mjs';
import * as staff from '../lib/competency-staff.ts';
import * as evaluation from '../lib/competency-test.ts';
import * as response from '../lib/competency-staff-response.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {act,create}=TestRenderer;
const directory='../app/dashboard/[companyId]/recruitments/[recruitmentId]/';
function load(name,mocks){
 const exports={};
 const code=ts.transpileModule(readFileSync(new URL(directory+name,import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(code,{exports,process,FormData,URL,crypto:{randomUUID},require(name){
  if(name==='react')return React;if(name==='react/jsx-runtime')return jsxRuntime;
  if(name in mocks)return mocks[name];throw new Error('Unexpected form dependency: '+name);
 }});return exports;
}

test('C3 mounted grant form rotates consecutively and retries an uncertain receipt with the original key/revision',async t=>{
 const e=await activeBoot(t,{fullChain:true}),{db,h,call}=e,f=await e.seed();
 const route={companyId:f.companyId,recruitmentId:f.recruitment.id,applicationId:f.application.id};
 for(const [key,value] of Object.entries({VERCEL_ENV:'preview',COMPETENCY_CANDIDATE_PREVIEW:'true',COMPETENCY_BROKER_ORIGIN:'https://candidate.example.test'})){
  const old=process.env[key];process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});
 }
 const calls=[];let uncertain=false;
 const client={
  from(table){assert.equal(table,'exercise_definition_entries');return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:{id:f.definitionId,definition:f.definition},error:null};}};},
  async rpc(name,args){
   await h.asUser(f.owner);calls.push({name,args});
   try{return {data:await call('public.'+name,Object.values(args)),error:null};}
   catch(error){return {data:null,error:{code:error.code}};}
  }
 };
 const actions=load('competency-actions.ts',{
  'next/cache':{revalidatePath(){if(uncertain){uncertain=false;throw Error('Synthetic response lost after COMMIT');}}},
  '../../../../../lib/behavior-context':{loadBehaviorContext:async()=>({client,canEdit:true})},
  '../../../../../lib/exercise-context':{exerciseUuid:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/},
  '../../../../../lib/competency-staff':staff,'../../../../../lib/competency-test':evaluation,
  '../../../../../lib/competency-staff-response':response
 });
 const {CompetencyGrantForm}=load('competency-forms.tsx',{'./competency-actions':actions});
 let props={route,definitionId:f.definitionId,canIssue:true},tree;
 await act(async()=>{tree=create(React.createElement(CompetencyGrantForm,props));});
 t.after(async()=>{await act(async()=>tree.unmount());});
 const form=()=>tree.root.findAllByType('form')[0];
 const requestKey=()=>form().findByProps({name:'requestKey'}).props.value;
 const link=()=>tree.root.findAllByType('textarea').find(node=>node.props.readOnly)?.props.value;
 async function submit(){const current=form(),data=new FormData();data.set('requestKey',requestKey());data.set('hours','24');
  await act(async()=>{React.startTransition(()=>current.props.action(data));});}
 async function refresh(){await h.asUser(f.owner);const current=staff.parseCompetencyAccess(await call('public.list_competency_test_access',[f.application.id]));
  props={...props,grant:current.access[0]};await act(async()=>tree.update(React.createElement(CompetencyGrantForm,props)));return props.grant.revision;}
 const issueKey=requestKey();await submit();assert.ok(link());assert.equal(await refresh(),1);assert.ok(link(),'revalidation preserves the one-time link');
 const keys=[];
 for(const revision of [2,3]){keys.push(requestKey());const oldLink=link();await submit();assert.notEqual(link(),oldLink);assert.equal(await refresh(),revision);assert.ok(link());}
 assert.equal(new Set([issueKey,...keys,requestKey()]).size,4,'each acknowledged operation permits a new intention');
 const revokeKey=tree.root.findAllByType('form')[1].findByProps({name:'requestKey'}).props.value;
 assert.notEqual(revokeKey,requestKey());
 const retryKey=requestKey();uncertain=true;await submit();assert.equal(link(),undefined,'uncertain mutation hides the old link');
 assert.equal(requestKey(),retryKey);assert.equal(await refresh(),4);
 await submit();assert.equal(await refresh(),4,'receipt retry never rotates again');assert.equal(link(),undefined,'receipt cannot recover a secret');
 const lastRotations=calls.filter(call=>call.name==='rotate_competency_test_grant').slice(-2);
 assert.equal(lastRotations[0].args.request_key,retryKey);assert.equal(lastRotations[1].args.request_key,retryKey);
 assert.equal(lastRotations[0].args.expected_revision,3);assert.equal(lastRotations[1].args.expected_revision,3);
 assert.notEqual(requestKey(),retryKey);await submit();assert.equal(await refresh(),5);assert.ok(link());
 await h.asAdmin();assert.equal((await db.query('select count(*)::int n from private.competency_test_grant_events where grant_id=$1 and kind=$2',[props.grant.grantId,'rotated'])).rows[0].n,4);
});
