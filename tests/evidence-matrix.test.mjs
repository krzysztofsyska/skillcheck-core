import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeEvidence, EvidenceResultSchema, evidenceSystemPrompt, evidenceOpenAiJsonSchema,
  locateQuote, validateEvidenceResult, verifyAnalysisInputs, snapshotHash,
  EVIDENCE_MAX_OUTPUT_TOKENS, EVIDENCE_TIMEOUT_MS,
} from '../lib/evidence-matrix.ts';

const material = { document_id:'40000000-0000-0000-0000-000000000004', version:2,
  text:'Przez 3 lata pracowałem\n  w  sprzedaży B2B. CRM: HubSpot.' };
const requirements = [
  {id:'task:1',kind:'task',text:'Sprzedaż B2B'},
  {id:'kpi:1',kind:'kpi',text:'Zrealizowany cel sprzedaży'},
];

function result(quotes=['w sprzedaży B2B']) {
  return {items:[
    {requirement_key:'task:1',verdict:'supported',quotes,missing_info:'',suggested_question:'Opisz proces sprzedaży B2B.'},
    {requirement_key:'kpi:1',verdict:'missing',quotes:[],missing_info:'Brak liczbowego celu.',suggested_question:'Jakie cele realizowałeś?'},
  ]};
}

test('verbatim quotes match source after normalizing whitespace; offsets preserve actual text',()=>{
  const found=locateQuote(material.text,'pracowałem w sprzedaży B2B.');
  assert.ok(found);
  assert.equal(material.text.slice(found.start,found.end),found.quote);
  assert.match(found.quote,/\n  w  /);
  assert.equal(locateQuote(material.text,'pracowałem w fintechu'),null);
  assert.equal(snapshotHash([{a:1}]),snapshotHash([{a:1}]));
  assert.notEqual(snapshotHash([{a:1}]),snapshotHash([{a:2}]));
});

test('invalid citations are removed and their verdict becomes missing',()=>{
  const good=validateEvidenceResult(result(['w sprzedaży B2B']),requirements,material);
  assert.equal(good[0].verdict,'supported');
  assert.equal(good[0].evidence_quotes[0].document_version,2);
  assert.equal(good[0].evidence_quotes[0].document_id,material.document_id);
  const bad=validateEvidenceResult(result(['pracowałem w Google']),requirements,material);
  assert.equal(bad[0].verdict,'missing');
  assert.deepEqual(bad[0].evidence_quotes,[]);
});

test('schema rejects unknown decision/protected fields, duplicate and missing criteria',()=>{
  assert.throws(()=>EvidenceResultSchema.parse({...result(),hireRecommendation:'hire'}));
  assert.throws(()=>EvidenceResultSchema.parse({...result(),items:[{...result().items[0],overall_score:95},result().items[1]]}));
  assert.throws(()=>EvidenceResultSchema.parse({...result(),items:[{...result().items[0],verdict:'hire'},result().items[1]]}));
  assert.throws(()=>validateEvidenceResult({...result(),items:[result().items[0],result().items[0]]},requirements,material));
  assert.throws(()=>validateEvidenceResult({items:[result().items[0]]},requirements,material));
  assert.throws(()=>validateEvidenceResult({...result(),items:[{...result().items[0],missing_info:'Informacja o zdrowiu'},result().items[1]]},requirements,material));
});

test('provider contract blocks protected attributes and automatic decisions',()=>{
  assert.match(evidenceSystemPrompt,/protected characteristics/i);
  assert.match(evidenceSystemPrompt,/not instructions/i);
  assert.match(evidenceSystemPrompt,/hiring\/rejection recommendation/i);
  assert.deepEqual(Object.keys(evidenceOpenAiJsonSchema.properties),['items']);
  assert.equal(evidenceOpenAiJsonSchema.additionalProperties,false);
  assert.ok(EVIDENCE_MAX_OUTPUT_TOKENS<=5000);
  assert.ok(EVIDENCE_TIMEOUT_MS<=30000);
  assert.throws(()=>verifyAnalysisInputs(requirements,'x'.repeat(18001)));
  assert.throws(()=>verifyAnalysisInputs(Array.from({length:31},(_,i)=>({id:'task:'+i,kind:'task',text:'Test'})),'abc'));
});

test('mock LLM happy-path is fully validated and returns source-linked matrix',async()=>{
  let called=false;
  const mockedFetch=async (_url,options)=>{
    called=true;
    const body=JSON.parse(options.body);
    assert.equal(body.store,false);
    assert.equal(body.max_output_tokens,EVIDENCE_MAX_OUTPUT_TOKENS);
    assert.match(body.input[0].content,/Do not make an overall candidate evaluation/i);
    assert.ok(!JSON.stringify(body.input).includes('source_text'));
    assert.match(options.headers.authorization,/Bearer test-only/);
    return {ok:true,json:async()=>({status:'completed',output_text:JSON.stringify(result())})};
  };
  const rows=await analyzeEvidence(requirements,material,'test-only',mockedFetch);
  assert.equal(called,true);
  assert.equal(rows.length,2);
  assert.equal(rows[0].verdict,'supported');
  assert.equal(rows[1].verdict,'missing');
  assert.equal(rows[1].evidence_quotes.length,0);
});
