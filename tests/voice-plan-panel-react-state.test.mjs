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
