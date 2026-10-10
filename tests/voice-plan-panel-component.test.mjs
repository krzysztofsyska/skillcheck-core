import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { getVoicePlanPanelPermissions } from "../lib/voice/plan-panel-state.ts";

const source = readFileSync(new URL("../components/voice/VoicePlanApprovalPanel.tsx", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mockJsx = (type, props) => ({ type, props: props ?? {} });
function renderPanel(props) {
  const exports = {};
  runInNewContext(js, {
    exports,
    require(name) {
      if (name === "react") return { useState: value => [value, () => {}] };
      if (name === "react/jsx-runtime") return { jsx: mockJsx, jsxs: mockJsx };
      if (name.endsWith("plan-panel-state")) return { getVoicePlanPanelPermissions };
      throw Error("Unapproved import: " + name);
    },
  });
  return exports.VoicePlanApprovalPanel(props);
}
function nodes(tree, result = []) {
  if (Array.isArray(tree)) { tree.forEach(x => nodes(x,result)); return result; }
  if (!tree || typeof tree !== "object") return result;
  if ("type" in tree) {
    result.push(tree);
    nodes(tree.props?.children,result);
  }
  return result;
}
const plan=(props={})=>({
  id:"00000000-0000-4000-8000-000000000009",
  status:"generated",sourceCurrent:true,planVersion:2,sourceHash:"a".repeat(64),
  reviewIsApproved:false,reviewerLabel:null,reviewedAt:null,
  questions:[
    {id:"common-responsibility",kind:"common",criterionId:"responsibility",criterionKind:"behavior",
      text:"Jak przyjąłeś odpowiedzialność za wynik?",followUps:["Co zrobiłeś osobiście?"]},
  ],...props,
});
function buttons(tree) {return nodes(tree).filter(n=>n.type==="button");}
test("SC-012-B B2 renders safe preview and disables review/release without backend",()=>{
 const tree=renderPanel({plan:plan(),role:"recruiter"});
 const all=nodes(tree);
 const list=buttons(tree);
 assert.equal(list.length,3);
 assert.ok(list.every(n=>n.props.disabled || all.some(x=>x.type==="fieldset" && x.props.disabled)));
 assert.ok(all.some(n=>typeof n.props.children==="string" && n.props.children.includes("Tryb podglądu")));
});
test("SC-012-B B2 shows requires_changes outcome instead of approved label",()=>{
 const tree=renderPanel({plan:plan({status:"reviewed",reviewIsApproved:false}),role:"recruiter",backendReady:true});
 assert.ok(nodes(tree).some(n=>n.props?.children==="Wymaga poprawy scenariusza" ||
   JSON.stringify(n.props?.children??"").includes("Wymaga poprawy scenariusza")));
 assert.ok(nodes(tree).some(n=>JSON.stringify(n.props?.children??"").includes("wymagane poprawki")));
 assert.equal(buttons(tree).at(-1).props.disabled,true);
});
test("SC-012-B B2 approved current plan invokes only bounded client review command",async()=>{
 let payload;
 const tree=renderPanel({plan:plan(),role:"recruiter",backendReady:true,
   onReview:async args=>{payload=args;}});
 const reviewButton=buttons(tree).find(x=>x.props.children==="Zatwierdź scenariusz");
 assert.equal(reviewButton.props.disabled,undefined);
 await reviewButton.props.onClick();
 assert.deepEqual(JSON.parse(JSON.stringify(payload)),{
   planId:plan().id,expectedVersion:2,expectedSourceHash:plan().sourceHash,decision:"approved",
 });
 assert.ok(!("companyId" in payload) && !("actorId" in payload) && !("candidateId" in payload));
});
test("SC-012-B B2 release only with current approved review",async()=>{
 const p=plan({status:"reviewed",reviewIsApproved:true});
 let releaseArgs;
 const tree=renderPanel({plan:p,role:"recruiter",backendReady:true,
   onRelease:async args=>{releaseArgs=args;}});
 const b=buttons(tree).at(-1);
 assert.equal(b.props.disabled,false);
 await b.props.onClick();
 assert.equal(releaseArgs.planId,p.id);
 assert.equal(releaseArgs.expectedSourceHash,p.sourceHash);
 const viewer=renderPanel({plan:p,role:"viewer",backendReady:true,
   onRelease:async()=>{throw Error("should not run");}});
 assert.equal(buttons(viewer).at(-1).props.disabled,true);
});
