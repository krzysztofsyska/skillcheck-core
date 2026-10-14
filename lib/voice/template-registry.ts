/**
 * Immutable code-side template registry for SC-012-B preflight.
 * Changing any approved template requires a NEW version identifier.
 * Production still requires a DB-backed immutable catalog + signed release.
 */
import {createHash} from "node:crypto";
import {behaviorGuideDefinitions} from "../behavior-guide.ts";

const v1=Object.freeze({
  version:"skillcheck-voice-plan-v1" as const,
  language:"pl-PL" as const,
  targetSeconds:420 as const,
  maximumSeconds:600 as const,
  recordingAllowed:false as const,
  noticeRequired:true as const,
  behaviorQuestionTexts:Object.freeze(behaviorGuideDefinitions.map(area=>
    Object.freeze({id:area.id,firstQuestion:area.questions[0]}))),
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
  /** Digested with the manifest so generator drift changes the catalog digest. */
  questionRules:Object.freeze({
    commonCount:4,
    maxClarificationCount:2,
    commonMaxSeconds:60,
    clarificationMaxSeconds:45,
    commonIdPrefix:"common-",
    clarificationIdPrefix:"clarification-",
    order:"required-level-desc-then-guide-order-then-gap-order",
  }),
  behaviorLevelRank:Object.freeze({
    Krytyczny:4,Wysoki:3,Standardowy:2,Niski:1,
  }),
  clarificationFollowUpByReason:Object.freeze({
    contradiction:0,missing_evidence:1,scope_unverified:1,
  }),
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
