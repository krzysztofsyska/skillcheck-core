import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {chromium} from 'playwright';
import ts from 'typescript';
import * as staff from '../lib/competency-staff.ts';
import * as evaluation from '../lib/competency-test.ts';
import * as response from '../lib/competency-staff-response.ts';

const require=createRequire(import.meta.url);
const directory='../app/dashboard/[companyId]/recruitments/[recruitmentId]/';
function compile(name){
 return ts.transpileModule(readFileSync(new URL(directory+name,import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
}
// Execute the installed ReactDOM in Chromium: native form resets are not
// implemented by react-test-renderer. Only the server transport is replaced.
function browserBundle(){
 const modules={};
 for(const [name,packageName,file] of [
  ['react','react','react.development.js'],
  ['react/jsx-runtime','react','react-jsx-runtime.development.js'],
  ['react-dom','react-dom','react-dom.development.js'],
  ['react-dom/client','react-dom','react-dom-client.development.js'],
  ['scheduler','scheduler','scheduler.development.js'],
 ])modules[name]=readFileSync(join(dirname(require.resolve(packageName)),'cjs',file),'utf8');
 modules['./competency-actions']='exports.saveCompetencyReview=(route,attemptId,version,state,form)=>window.saveReview(route,attemptId,version,state,[...form]);';
 modules.form=compile('competency-forms.tsx');
 return `(() => {
  const process={env:{NODE_ENV:'development'}},cache={};
  const modules={${Object.entries(modules).map(([name,source])=>JSON.stringify(name)+':(module,exports,require)=>{'+source+'\n}').join(',')}};
  function require(name){if(!cache[name]){const module=cache[name]={exports:{}};modules[name](module,module.exports,require);}return cache[name].exports;}
  window.mountReview=props=>require('react-dom/client').createRoot(document.getElementById('root')).render(require('react').createElement(require('form').CompetencyReviewForm,props));
 })();`;
}
const definition={kind:'competency_test',title:'Plan projektu',instructions:'Przygotuj plan.',expectedOutput:'Plan i komunikacja.',durationMinutes:30,
 criteria:['Planowanie','Komunikacja'].map(competency=>({competency,below:'Brak konkretów.',meets:'Konkretny plan.',above:'Plan z uzasadnieniem.'}))};
const route={companyId:'10000000-0000-4000-8000-000000000001',recruitmentId:'10000000-0000-4000-8000-000000000002',applicationId:'10000000-0000-4000-8000-000000000003'};
const attemptId='10000000-0000-4000-8000-000000000004',version=5;
const answer='Plan obejmuje terminy. Komunikacja obejmuje ryzyka.';

for(const scenario of ['invalid quote','version conflict'])test('review preserves every rating and quote after '+scenario,async t=>{
 const calls=[],saves=[],errors=[];let revalidated=0;
 const client={
  from(){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:{definition},error:null};}};},
  async rpc(name,args){
   if(name==='read_competency_test_response')return {data:{...route,attemptId,definitionId:'definition',workSample:answer},error:null};
   assert.equal(name,'save_competency_test_review');saves.push(structuredClone(args));
   return scenario==='version conflict'?{error:{code:'PT409'}}:{data:{},error:null};
  }
 };
 const mocks={
  'next/cache':{revalidatePath(){revalidated++;}},
  '../../../../../lib/behavior-context':{loadBehaviorContext:async()=>({client,canEdit:true})},
  '../../../../../lib/exercise-context':{exerciseUuid:/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/},
  '../../../../../lib/competency-staff':staff,'../../../../../lib/competency-test':evaluation,
  '../../../../../lib/competency-staff-response':response
 };
 const exports={};
 runInNewContext(compile('competency-actions.ts'),{exports,Error,URL,process:{env:{NODE_ENV:'development',COMPETENCY_CANDIDATE_PREVIEW:'true'}},
  require(name){assert.ok(name in mocks,'Unexpected dependency: '+name);return mocks[name];}});
 const browser=await chromium.launch({headless:true,executablePath:process.env.SKILLCHECK_TEST_CHROME});
 t.after(()=>browser.close());
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('saveReview',async(receivedRoute,receivedAttempt,receivedVersion,state,entries)=>{
  calls.push({route:receivedRoute,attemptId:receivedAttempt,version:receivedVersion,entries});
  const form=new FormData();for(const [key,value] of entries)form.append(key,value);
  return exports.saveCompetencyReview(receivedRoute,receivedAttempt,receivedVersion,state,form);
 });
 await page.setContent('<div id="root"></div>');
 await page.addScriptTag({content:browserBundle()});
 await page.evaluate(props=>{
  window.resetCount=0;document.addEventListener('reset',()=>window.resetCount++,true);window.mountReview(props);
 },{route,attemptId,version,definition});
 const values={'rating-0':'above','evidence-0':scenario==='invalid quote'?'Nieistniejący cytat.':'Plan obejmuje terminy.',
  'rating-1':'meets','evidence-1':'Komunikacja obejmuje ryzyka.'};
 for(const [name,value] of Object.entries(values)){
  const field=page.locator('[name="'+name+'"]');
  if(name.startsWith('rating'))await field.selectOption(value);else await field.fill(value);
 }
 await page.getByRole('button',{name:'Zapisz ocenę z dowodami'}).click();
 const expectedError=scenario==='invalid quote'?'Ocena wymaga dokładnego cytatu z odpowiedzi kandydata.':staff.competencyActionError('PT409');
 await page.getByRole('alert').waitFor();
 await page.waitForFunction(()=>window.resetCount===1);
 assert.equal(await page.getByRole('alert').textContent(),expectedError);
 const actual=await page.locator('select,textarea').evaluateAll(fields=>Object.fromEntries(fields.map(field=>[field.name,field.value])));
 assert.deepEqual(actual,values,'React action reset must retain every assessment field');
 assert.equal(await page.getByRole('button',{name:'Zapisz ocenę z dowodami'}).isEnabled(),true);
 assert.equal(calls.length,1,'failed save must not automatically retry');
 assert.deepEqual(calls[0],{route,attemptId,version,entries:Object.entries(values)});
 assert.equal(revalidated,0,'failed save must not refresh away the inputs or error');
 assert.equal(saves.length,scenario==='invalid quote'?0:1);
 if(saves.length)assert.equal(saves[0].expected_version,version,'conflict keeps optimistic concurrency intact');
 if(scenario==='invalid quote'){
  await page.locator('[name="evidence-0"]').fill('Plan obejmuje terminy.');
  await page.getByRole('button',{name:'Zapisz ocenę z dowodami'}).click();
  await page.getByRole('status').waitFor();
  assert.equal(calls.length,2);assert.equal(saves.length,1);assert.equal(revalidated,1);
  assert.deepEqual(saves[0].observations,[{criterionIndex:0,rating:'above',evidence:'Plan obejmuje terminy.'},
   {criterionIndex:1,rating:'meets',evidence:values['evidence-1']}]);
  assert.equal(await page.getByRole('alert').count(),0);
 }
 assert.deepEqual(errors,[]);
});
