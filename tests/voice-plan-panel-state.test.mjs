import test from "node:test";
import assert from "node:assert/strict";
import { getVoicePlanPanelPermissions } from "../lib/voice/plan-panel-state.ts";
const base={status:"generated",sourceCurrent:true,backendReady:false,role:"recruiter",reviewIsApproved:false};
test("SC-012-B panel fails closed until backend authorization exists",()=>{
 const result=getVoicePlanPanelPermissions(base);
 assert.equal(result.reviewEnabled,false);
 assert.equal(result.releaseEnabled,false);
 assert.match(result.warning,/backend/);
});
test("SC-012-B source stale and viewer deny both actions",()=>{
 for(const state of [{...base,backendReady:true,sourceCurrent:false},
   {...base,backendReady:true,status:"stale"},
   {...base,backendReady:true,role:"viewer"}]){
   const p=getVoicePlanPanelPermissions(state);
   assert.equal(p.reviewEnabled,false);
   assert.equal(p.releaseEnabled,false);
   assert.ok(p.warning);
 }
});
test("SC-012-B only reviewed and approved current plan is eligible for release",()=>{
 assert.equal(getVoicePlanPanelPermissions({...base,backendReady:true}).reviewEnabled,true);
 assert.equal(getVoicePlanPanelPermissions({...base,backendReady:true}).releaseEnabled,false);
 assert.equal(getVoicePlanPanelPermissions({...base,backendReady:true,status:"reviewed",reviewIsApproved:false}).releaseEnabled,false);
 assert.equal(getVoicePlanPanelPermissions({...base,backendReady:true,status:"reviewed",reviewIsApproved:true}).releaseEnabled,true);
 assert.equal(getVoicePlanPanelPermissions({...base,backendReady:true,status:"released",reviewIsApproved:true}).releaseEnabled,false);
});
