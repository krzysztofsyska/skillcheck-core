import test from "node:test";
import assert from "node:assert/strict";
import { selectReviewedScreeningGaps, ScreeningGapSelectionError } from "../lib/voice/screening-gap-selection.ts";

const source=()=>({
  latestHumanDecision:"approved",analysisCompleted:true,analysisCurrent:true,shortlistCurrent:true,
  criteria:[{id:"kpi:1",kind:"kpi"},{id:"task:2",kind:"task"},{id:"task:1",kind:"task"},
    {id:"competency:1",kind:"competency"}],
  results:[{criterionId:"task:1",rating:"insufficient_data"},{criterionId:"kpi:1",rating:"insufficient_data"},
    {criterionId:"task:2",rating:"insufficient_data"},{criterionId:"competency:1",rating:"insufficient_data"}],
  overrides:[],
});
test("SC-012-B selects two gaps in task/kpi/competency and numeric index order",()=>{
 assert.deepEqual(selectReviewedScreeningGaps(source()),[
   {criterionId:"task:1",kind:"task",reason:"missing_evidence"},
   {criterionId:"task:2",kind:"task",reason:"missing_evidence"},
 ]);
});
test("SC-012-B human approved override replaces only matching criterion rating",()=>{
 let s=source();
 s.overrides=[{criterionId:"task:1",rating:"meets"}];
 assert.deepEqual(selectReviewedScreeningGaps(s),[
   {criterionId:"task:2",kind:"task",reason:"missing_evidence"},
   {criterionId:"kpi:1",kind:"kpi",reason:"missing_evidence"},
 ]);
});
test("SC-012-B refuses stale, rejected, incomplete and unreviewed sources",()=>{
 const s=source();
 for(const changed of [{analysisCurrent:false},{analysisCompleted:false},{shortlistCurrent:false},
   {latestHumanDecision:"requires_changes"},{latestHumanDecision:"rejected"}, {latestHumanDecision:"unknown"},
   {results:s.results.slice(0,2)}, {overrides:[{criterionId:"task:90",rating:"meets"}]},
   {criteria:[...s.criteria,{id:"task:1",kind:"task"}]}]){
   assert.throws(()=>selectReviewedScreeningGaps({...s,...changed}),ScreeningGapSelectionError);
 }
});
test("SC-012-B rejects same criterion repeated and invalid machine-invented reasons",()=>{
 const s=source();
 assert.throws(()=>selectReviewedScreeningGaps({...s,results:[
   {...s.results[0]},...s.results.slice(0,3),
 ]}),ScreeningGapSelectionError);
 assert.throws(()=>selectReviewedScreeningGaps({...s,overrides:[
   {criterionId:"kpi:1",rating:"insufficient_data"},
   {criterionId:"kpi:1",rating:"above"},
 ]}),ScreeningGapSelectionError);
 assert.throws(()=>selectReviewedScreeningGaps({...s,results:[
  {...s.results[0],rating:"contradiction"},...s.results.slice(1),
 ]}),ScreeningGapSelectionError);
});

test("SC-012-B plain human approval must not inherit previous correction rows",()=>{
 const x=source();
 assert.throws(()=>selectReviewedScreeningGaps({...x,overrides:[
   {criterionId:"task:1",rating:"above"},
 ]}),ScreeningGapSelectionError);
 assert.deepEqual(selectReviewedScreeningGaps({...x,latestHumanDecision:"approved_with_changes",
   overrides:[{criterionId:"task:1",rating:"above"}]}).map(g=>g.criterionId),["task:2","kpi:1"]);
});
