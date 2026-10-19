/**
 * Immutable code-side template registry for SC-012-B preflight.
 * Changing any approved template requires a NEW version identifier.
 * Production still requires a DB-backed immutable catalog + signed release.
 */
import {createHash} from "node:crypto";
import {behaviorGuideDefinitions} from "../behavior-guide.ts";
import type {InterviewSource,InterviewQuestion} from "./interview-plan.ts";

const v1=Object.freeze({
  version:"skillcheck-voice-plan-v1" as const,
  language:"pl-PL" as const,
  targetSeconds:420 as const,
  maximumSeconds:600 as const,
  recordingAllowed:false as const,
  noticeRequired:true as const,
  selectionRules:Object.freeze({
    commonCount:4,clarificationLimit:2,commonMaxSeconds:60,clarificationMaxSeconds:45,
    priorityLevels:Object.freeze(["Krytyczny","Wysoki","Standardowy","Niski"]),
    stableTieBreak:"behavior-guide-order",
    outputOrder:"common-then-clarification-in-source-order",
    gapQualifyingRatings:Object.freeze(["insufficient_data"]),
    gapKindOrder:Object.freeze(["task","kpi","competency"]),
    gapReason:"missing_evidence" as const,
  }),
  behaviorQuestionTexts:Object.freeze(behaviorGuideDefinitions.map((area,index)=>
    Object.freeze({id:area.id,label:area.label,index,firstQuestion:area.questions[0]}))),
  commonFollowUp:"Jakie działania podjął Pan lub podjęła Pani osobiście i jaki był rezultat?",
  clarificationQuestionTexts:Object.freeze({
    task:"Proszę opisać konkretne zadanie, które wykonywał Pan lub wykonywała Pani osobiście, i jego rezultat.",
    kpi:"Proszę podać konkretny przykład mierzenia wyniku swojej pracy i działania na podstawie tego miernika.",
    competency:"Proszę opisać, w jakiej sytuacji zawodowej wykorzystał Pan lub wykorzystała Pani konkretną umiejętność i jaki był efekt.",
  }),
  clarificationFollowUps:Object.freeze([
    "W dokumentach informacje dotyczące tego kryterium są niespójne. Jaki był rzeczywisty zakres Pani lub Pana pracy?",
    "Jaki był Pani lub Pana rzeczywisty zakres działania i rezultat?",
  ]),
});
const registry=Object.freeze({"skillcheck-voice-plan-v1":v1});
export type VoiceTemplateVersion=keyof typeof registry;
export function getTrustedVoiceTemplate(version:unknown){
  if(typeof version!=="string"||
     !Object.prototype.hasOwnProperty.call(registry,version))
    throw new Error("VOICE_TEMPLATE_UNSUPPORTED");
  return registry[version as VoiceTemplateVersion];
}
export function trustedVoiceTemplateDigest(version:VoiceTemplateVersion){
  return createHash("sha256").update(JSON.stringify(getTrustedVoiceTemplate(version))).digest("hex");
}
/** Rebuild clarification gaps from the frozen manifest rules and the locked
 * screening rows. This does not call the selector, so a selector change that
 * keeps the v1 id fails the comparison in the verifier. */
export function pinnedClarificationGaps(input:Readonly<{
  criteria:readonly {id:string;kind:"task"|"kpi"|"competency"}[];
  results:readonly {criterionId:string;rating:string}[];
  overrides:readonly {criterionId:string;rating:string|null}[];
}>):readonly {criterionId:string;kind:"task"|"kpi"|"competency";reason:"missing_evidence"}[]{
  const rules=getTrustedVoiceTemplate("skillcheck-voice-plan-v1").selectionRules;
  const qualifying=new Set<string>(rules.gapQualifyingRatings);
  const effective=new Map(input.results.map(row=>[row.criterionId,row.rating]));
  for(const change of input.overrides){
    if(change.rating!==null)effective.set(change.criterionId,change.rating);
  }
  return input.criteria.map(criterion=>{
    const match=/^(task|kpi|competency):([1-9][0-9]?)$/.exec(criterion.id);
    if(!match||match[1]!==criterion.kind)throw Error("VOICE_TEMPLATE_GAP_INVALID");
    return {id:criterion.id,kind:criterion.kind,index:Number(match[2])};
  }).filter(criterion=>qualifying.has(effective.get(criterion.id)??""))
    .sort((a,b)=>rules.gapKindOrder.indexOf(a.kind)-rules.gapKindOrder.indexOf(b.kind)||a.index-b.index)
    .slice(0,rules.clarificationLimit)
    .map(criterion=>({criterionId:criterion.id,kind:criterion.kind,reason:rules.gapReason}));
}

/**
 * Independently reconstruct every question-defining field from the frozen
 * version manifest. A generator change (order, count, duration, kind, ID,
 * follow-up, priority) is rejected even when its question text is unchanged.
 */
export function assertPinnedVoiceQuestions(
  source:InterviewSource,questions:readonly InterviewQuestion[],
):void{
  const t=getTrustedVoiceTemplate("skillcheck-voice-plan-v1");
  const priorities=t.behaviorQuestionTexts.map(area=>{
    const matching=source.position.requiredBehaviors.filter(raw=>
      raw.slice(0,raw.indexOf(":")).trim()===area.label);
    if(matching.length!==1)throw Error("VOICE_TEMPLATE_BEHAVIOR_INVALID");
    const level=matching[0].slice(matching[0].indexOf(":")+1).trim();
    const rank=t.selectionRules.priorityLevels.indexOf(level as
      typeof t.selectionRules.priorityLevels[number]);
    if(rank<0)throw Error("VOICE_TEMPLATE_BEHAVIOR_INVALID");
    return {...area,rank};
  }).sort((a,b)=>a.rank-b.rank||a.index-b.index);
  const expected:InterviewQuestion[]=[
    ...priorities.slice(0,t.selectionRules.commonCount).map(area=>({
      id:"common-"+area.id,kind:"common" as const,criterionId:area.id,
      criterionKind:"behavior" as const,text:area.firstQuestion,
      followUps:[t.commonFollowUp],maxSeconds:t.selectionRules.commonMaxSeconds,
    })),
    ...source.gaps.map(gap=>({
      id:"clarification-"+gap.criterionId.replace(":","-"),
      kind:"clarification" as const,criterionId:gap.criterionId,
      criterionKind:gap.kind,
      text:t.clarificationQuestionTexts[gap.kind],
      followUps:[gap.reason==="contradiction"?
        t.clarificationFollowUps[0]:t.clarificationFollowUps[1]],
      maxSeconds:t.selectionRules.clarificationMaxSeconds,
    })),
  ];
  if(source.gaps.length>t.selectionRules.clarificationLimit||
     JSON.stringify(expected)!==JSON.stringify(questions))
    throw Error("VOICE_TEMPLATE_GENERATOR_DRIFT");
}
