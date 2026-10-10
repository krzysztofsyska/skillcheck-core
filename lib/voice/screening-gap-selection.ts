/**
 * SC-012-B B1: deterministic gap selection from *reviewed* screening results.
 * The caller MUST load and authorize the tenant/application/approved analysis
 * in a single source snapshot (SC-006/008) before calling this pure function.
 * Current screening schema has NO machine-reviewed "contradiction" or
 * "scope_unverified" flags, so neither reason may be inferred from prose.
 */
import type { VoiceEvidenceGap } from "./interview-plan.ts";

export type ScreeningRatingForVoice = "insufficient_data" | "below" | "meets" | "above";
export type ScreeningCriterionForVoice = Readonly<{
  id: string; kind: "task" | "kpi" | "competency";
}>;
export type ScreeningResultForVoice = Readonly<{
  criterionId: string; rating: ScreeningRatingForVoice;
}>;
export type ScreeningReviewOverrideForVoice = Readonly<{
  criterionId: string; rating: ScreeningRatingForVoice;
}>;
export type ScreeningGapSelectionSource = Readonly<{
  latestHumanDecision: "approved" | "approved_with_changes" | "requires_changes" | "rejected";
  analysisCompleted: boolean; analysisCurrent: boolean; shortlistCurrent: boolean;
  criteria: readonly ScreeningCriterionForVoice[];
  results: readonly ScreeningResultForVoice[];
  overrides: readonly ScreeningReviewOverrideForVoice[];
}>;
export class ScreeningGapSelectionError extends Error {
  constructor() { super("VOICE_GAPS_UNVERIFIED_SOURCE"); }
}
const invalid = (): never => { throw new ScreeningGapSelectionError(); };
const kinds = ["task","kpi","competency"] as const;
const ratings = ["insufficient_data","below","meets","above"] as const;
function parseCriterion(c: ScreeningCriterionForVoice): { id:string; kind:typeof kinds[number]; index:number } {
  if (!c || typeof c.id !== "string" || !kinds.includes(c.kind)) invalid();
  const match = /^(task|kpi|competency):([1-9][0-9]?)$/.exec(c.id);
  if (!match) return invalid();
  if (match[1]!==c.kind) return invalid();
  const index=Number(match[2]);
  if (!Number.isSafeInteger(index)||index>30) invalid();
  return {id:c.id,kind:c.kind,index};
}
function validRating(v:unknown): v is ScreeningRatingForVoice {
  return typeof v==="string" && (ratings as readonly string[]).includes(v);
}
export function selectReviewedScreeningGaps(
  src: ScreeningGapSelectionSource,
): readonly VoiceEvidenceGap[] {
  if (!src || !["approved","approved_with_changes"].includes(src.latestHumanDecision) ||
      src.analysisCompleted!==true || src.analysisCurrent!==true ||
      src.shortlistCurrent!==true || !Array.isArray(src.criteria) || !Array.isArray(src.results) ||
      !Array.isArray(src.overrides) || src.criteria.length===0 || src.criteria.length>90 ||
      src.results.length!==src.criteria.length || src.overrides.length>src.criteria.length) invalid();
  const order=new Map<string,{id:string;kind:typeof kinds[number];index:number}>();
  const seenIndex=new Map<string,Set<number>>();
  for(const raw of src.criteria){
    const c=parseCriterion(raw);
    if(order.has(c.id)) invalid();
    order.set(c.id,c);
    const indexes=seenIndex.get(c.kind)||new Set<number>();
    indexes.add(c.index);
    seenIndex.set(c.kind,indexes);
  }
  // Approved screening criteria always start at 1 and have contiguous indices.
  for(const indexes of Array.from(seenIndex.values())){
    if(Array.from(indexes).some(n=>n<1 || n>indexes.size)) invalid();
  }
  const resultMap=new Map<string,ScreeningRatingForVoice>();
  for(const result of src.results){
    if (!result || typeof result.criterionId!=="string" || !order.has(result.criterionId) ||
        resultMap.has(result.criterionId)||!validRating(result.rating)) invalid();
    resultMap.set(result.criterionId,result.rating);
  }
  const effective=new Map(resultMap);
  const overrideSeen=new Set<string>();
  for(const change of src.overrides){
    if (!change || typeof change.criterionId!=="string" || !order.has(change.criterionId) ||
        overrideSeen.has(change.criterionId)||!validRating(change.rating)) invalid();
    overrideSeen.add(change.criterionId);
    effective.set(change.criterionId,change.rating);
  }
  const candidates=Array.from(order.values())
    .filter(c=>effective.get(c.id)==="insufficient_data")
    .sort((a,b)=>kinds.indexOf(a.kind)-kinds.indexOf(b.kind)||a.index-b.index)
    .slice(0,2)
    .map(c=>Object.freeze({criterionId:c.id,kind:c.kind,reason:"missing_evidence" as const}));
  return Object.freeze(candidates);
}
