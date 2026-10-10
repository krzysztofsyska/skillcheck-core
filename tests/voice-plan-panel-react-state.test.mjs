import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import jsxRuntime from "react/jsx-runtime";
import TestRenderer from "react-test-renderer";
import ts from "typescript";
import { getVoicePlanPanelPermissions } from "../lib/voice/plan-panel-state.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { create, act } = TestRenderer;
const componentSource=readFileSync(new URL("../components/voice/VoicePlanApprovalPanel.tsx",import.meta.url),"utf8");
const compiled=ts.transpileModule(componentSource,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022
}}).outputText;
function component(){
 const exports={};
 runInNewContext(compiled,{exports,require(name){
   if(name==="react")return React;
   if(name==="react/jsx-runtime")return jsxRuntime;
   if(name.endsWith("plan-panel-state"))return {getVoicePlanPanelPermissions};
   throw Error("Unapproved import: "+name);
 }});
 return exports.VoicePlanApprovalPanel;
}
const Panel=component();
const plan=()=>({
 id:"00000000-0000-4000-8000-000000000009",status:"generated",
 sourceCurrent:true,planVersion:2,sourceHash:"a".repeat(64),
 reviewIsApproved:false,reviewerLabel:null,reviewedAt:null,
 questions:[{id:"common-responsibility",kind:"common",criterionId:"responsibility",
  criterionKind:"behavior",text:"Przykład odpowiedzialności?",followUps:["Dopytanie"]}],
});
function button(tree,label){
 return tree.root.findAllByType("button").find(n=>n.props.children===label);
}
test("SC-012-B real React renderer submits typed requires_changes rationale after rerender",async()=>{
 let received=null;
 let tree;
 await act(async()=>{tree=create(React.createElement(Panel,{
    plan:plan(),role:"recruiter",backendReady:true,
    onReview:async x=>{received=x;}
 }));});
 await act(async()=>{
   tree.root.findByType("textarea").props.onChange({target:{value:"Pytanie wymaga doprecyzowania"}});
 });
 assert.equal(tree.root.findByType("textarea").props.value,"Pytanie wymaga doprecyzowania");
 await act(async()=>{await button(tree,"Wymaga poprawy").props.onClick();});
 assert.deepEqual(JSON.parse(JSON.stringify(received)),{
   planId:plan().id,expectedVersion:2,expectedSourceHash:plan().sourceHash,
   decision:"requires_changes",reason:"Pytanie wymaga doprecyzowania"
 });
 assert.equal(tree.root.findByType("textarea").props.value,"");
 await act(async()=>tree.unmount());
});
test("SC-012-B real React renderer preserves typed rationale after failed review",async()=>{
 let attempts=0;
 let tree;
 await act(async()=>{tree=create(React.createElement(Panel,{
   plan:plan(),role:"recruiter",backendReady:true,
   onReview:async()=>{attempts++;throw Error("Synthetic 409");}
 }));});
 await act(async()=>{tree.root.findByType("textarea").props.onChange({target:{value:"Zmiana kryterium"} });});
 await act(async()=>{await button(tree,"Wymaga poprawy").props.onClick();});
 assert.equal(attempts,1);
 assert.equal(tree.root.findByType("textarea").props.value,"Zmiana kryterium");
 assert.ok(tree.root.findAllByProps({role:"alert"}).some(n=>JSON.stringify(n.props.children).includes("Nie udało")));
 await act(async()=>tree.unmount());
});


test("SC-012-B real React renderer disables reviewer controls during an unresolved request",async()=>{
 let releaseRequest;
 const pending=new Promise(resolve=>{releaseRequest=resolve;});
 let tree, completion;
 await act(async()=>{tree=create(React.createElement(Panel,{
   plan:plan(),role:"recruiter",backendReady:true,onReview:async()=>pending
 }));});
 await act(async()=>{tree.root.findByType("textarea").props.onChange({target:{value:"Opis korekty"}});});
 await act(async()=>{completion=button(tree,"Wymaga poprawy").props.onClick();});
 assert.equal(tree.root.findByType("fieldset").props.disabled,true);
 assert.equal(button(tree,"Wydaj zatwierdzony scenariusz").props.disabled,true);
 assert.equal(tree.root.findByType("textarea").props.value,"Opis korekty");
 await act(async()=>{releaseRequest();await completion;});
 assert.equal(tree.root.findByType("fieldset").props.disabled,true,
   "review success stays latched until server props advance");
 await act(async()=>tree.unmount());
});
test("SC-012-B changing plan version clears rationale and previous review error",async()=>{
 let tree;
 const original=plan();
 const props={plan:original,role:"recruiter",backendReady:true,
   onReview:async()=>{throw Error("simulated conflict");}};
 await act(async()=>{tree=create(React.createElement(Panel,props));});
 await act(async()=>{tree.root.findByType("textarea").props.onChange({target:{value:"Rationale belongs only to old plan"}});});
 await act(async()=>{await button(tree,"Wymaga poprawy").props.onClick();});
 assert.ok(tree.root.findAllByProps({role:"alert"}).length>0);
 await act(async()=>{tree.update(React.createElement(Panel,{
   ...props,plan:{...original,planVersion:original.planVersion+1},
 }));});
 assert.equal(tree.root.findByType("textarea").props.value,"");
 assert.equal(tree.root.findAllByProps({role:"alert"}).length,0);
 await act(async()=>tree.unmount());
});


test("SC-012-B ignores obsolete review completion while replacement plan has its own pending review",async()=>{
 const resolvers=[];
 let tree, oldCompletion, newCompletion;
 const onReview=()=>new Promise(resolve=>resolvers.push(resolve));
 const p1=plan();
 await act(async()=>{tree=create(React.createElement(Panel,{
   plan:p1,role:"recruiter",backendReady:true,onReview,
 }));});
 await act(async()=>{tree.root.findByType("textarea").props.onChange({target:{value:"Old reason"}});});
 await act(async()=>{oldCompletion=button(tree,"Wymaga poprawy").props.onClick();});
 assert.equal(resolvers.length,1);
 const p2={...p1,id:"00000000-0000-4000-8000-000000000098",planVersion:3};
 await act(async()=>{tree.update(React.createElement(Panel,{
   plan:p2,role:"recruiter",backendReady:true,onReview,
 }));});
 await act(async()=>{tree.root.findByType("textarea").props.onChange({target:{value:"New plan reason"}});});
 await act(async()=>{newCompletion=button(tree,"Wymaga poprawy").props.onClick();});
 assert.equal(resolvers.length,2);
 assert.equal(tree.root.findByType("fieldset").props.disabled,true);
 await act(async()=>{resolvers[0]();await oldCompletion;});
 assert.equal(tree.root.findByType("fieldset").props.disabled,true,
   "old finally must not re-enable the new pending review");
 assert.equal(tree.root.findByType("textarea").props.value,"New plan reason",
   "old success must not erase the new plan rationale");
 await act(async()=>{resolvers[1]();await newCompletion;});
 assert.equal(tree.root.findByType("fieldset").props.disabled,true,
   "successful replacement review remains latched until server props update");
 await act(async()=>tree.unmount());
});
test("SC-012-B obsolete failure does not show an error on replacement plan",async()=>{
 let rejectOld;
 let tree,oldCompletion;
 const pending=new Promise((_resolve,reject)=>{rejectOld=reject;});
 const p1=plan();
 await act(async()=>{tree=create(React.createElement(Panel,{
   plan:p1,role:"recruiter",backendReady:true,onReview:()=>pending
 }));});
 await act(async()=>{tree.root.findByType("textarea").props.onChange({target:{value:"Old request"}});});
 await act(async()=>{oldCompletion=button(tree,"Wymaga poprawy").props.onClick();});
 await act(async()=>{tree.update(React.createElement(Panel,{
   plan:{...p1,planVersion:9},role:"recruiter",backendReady:true,onReview:()=>pending
 }));});
 await act(async()=>{rejectOld(Error("old request rejected"));await oldCompletion;});
 assert.equal(tree.root.findAllByProps({role:"alert"}).length,0);
 await act(async()=>tree.unmount());
});

test("SC-012-B A -> B -> A always remounts and rejects the obsolete A completion",async()=>{
 const resolvers=[];
 const onReview=()=>new Promise(resolve=>resolvers.push(resolve));
 let tree,oldCompletion,newCompletion;
 const a=plan(),b={...a,id:"00000000-0000-4000-8000-000000000041"};
 const props=p=>({plan:p,role:"recruiter",backendReady:true,onReview});
 await act(async()=>{tree=create(React.createElement(Panel,props(a)));});
 await act(async()=>{tree.root.findByType("textarea").props.onChange({target:{value:"old-A"}});});
 await act(async()=>{oldCompletion=button(tree,"Wymaga poprawy").props.onClick();});
 await act(async()=>{tree.update(React.createElement(Panel,props(b)));});
 await act(async()=>{tree.update(React.createElement(Panel,props(a)));});
 await act(async()=>{tree.root.findByType("textarea").props.onChange({target:{value:"new-A"}});});
 await act(async()=>{newCompletion=button(tree,"Wymaga poprawy").props.onClick();});
 assert.equal(resolvers.length,2);
 await act(async()=>{resolvers[0]();await oldCompletion;});
 assert.equal(tree.root.findByType("fieldset").props.disabled,true);
 assert.equal(tree.root.findByType("textarea").props.value,"new-A");
 await act(async()=>{resolvers[1]();await newCompletion;});
 assert.equal(tree.root.findByType("fieldset").props.disabled,true,
    "successful new A review must remain latched");
 await act(async()=>tree.unmount());
});
test("SC-012-B duplicate actions cannot be submitted after success before props update",async()=>{
 let reviewCalls=0,releaseCalls=0,tree;
 const p=plan();
 await act(async()=>{tree=create(React.createElement(Panel,{
   plan:p,role:"recruiter",backendReady:true,onReview:async()=>{reviewCalls++;}
 }));});
 await act(async()=>{await button(tree,"Zatwierdź scenariusz").props.onClick();});
 assert.equal(tree.root.findByType("fieldset").props.disabled,true);
 await act(async()=>{await button(tree,"Zatwierdź scenariusz").props.onClick();});
 assert.equal(reviewCalls,1);
 await act(async()=>{tree.update(React.createElement(Panel,{
   plan:{...p,status:"reviewed",reviewIsApproved:true},role:"recruiter",backendReady:true,
   onRelease:async()=>{releaseCalls++;}
 }));});
 assert.equal(button(tree,"Wydaj zatwierdzony scenariusz").props.disabled,false,
   "review latch must not suppress separate release");
 await act(async()=>{await button(tree,"Wydaj zatwierdzony scenariusz").props.onClick();});
 assert.equal(button(tree,"Wydaj zatwierdzony scenariusz").props.disabled,true);
 await act(async()=>{await button(tree,"Wydaj zatwierdzony scenariusz").props.onClick();});
 assert.equal(releaseCalls,1);
 await act(async()=>tree.unmount());
});
