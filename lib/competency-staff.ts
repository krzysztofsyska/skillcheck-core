import { evaluateCompetencyTest } from './competency-test.ts';
import { staffWorkSample } from './competency-staff-response.ts';
import type { BehaviorRoute } from './behavior-context';
import type { ExerciseDefinition } from './exercise-definition';

const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const competencyStates={not_started:'Nie rozpoczęto',in_progress:'W trakcie',submitted:'Przesłano',
 revoked:'Dostęp odwołany',withdrawn:'Dostęp wycofany',unavailable:'Poza shortlistą',expired:'Termin minął'} as const;
export type CompetencyAccess={grantId:string;definitionId:string;revision:number;startBy:string;
 state:keyof typeof competencyStates;attemptId:string|null;deadlineAt:string|null};
function object(value:unknown):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Niezgodne dane testu.');
 return value as Record<string,unknown>;
}
export function parseCompetencyAccess(value:unknown) {
 const row=object(value);
 if(typeof row.cancelled!=='boolean'||typeof row.shortlisted!=='boolean'||!Array.isArray(row.access))throw new Error('Niezgodny status dostępu.');
 const access:CompetencyAccess[]=row.access.map(value=>{
  const r=object(value);
  if(typeof r.grantId!=='string'||!uuid.test(r.grantId)||typeof r.definitionId!=='string'||!uuid.test(r.definitionId)||
   !Number.isSafeInteger(r.revision)||Number(r.revision)<1||typeof r.startBy!=='string'||!Number.isFinite(Date.parse(r.startBy))||
   typeof r.state!=='string'||!Object.hasOwn(competencyStates,r.state)||
   !(r.attemptId===null||(typeof r.attemptId==='string'&&uuid.test(r.attemptId)))||
   !(r.deadlineAt===null||(typeof r.deadlineAt==='string'&&Number.isFinite(Date.parse(r.deadlineAt)))))throw new Error('Niezgodny status testu.');
  return r as CompetencyAccess;
 });
 return {cancelled:row.cancelled,shortlisted:row.shortlisted,access};
}
export function competencyReport(value:unknown,scope:BehaviorRoute,attemptId:string,definitionId:string,definition:ExerciseDefinition) {
 const answer=staffWorkSample(value,scope,attemptId),row=object(value);
 if(row.definitionId!==definitionId||definition.kind!=='competency_test'||!Array.isArray(row.reviews))throw new Error('Niezgodna wersja testu.');
 const reviews=row.reviews.map(value=>{
  const r=object(value);
  if(r.company_id!==scope.companyId||r.application_id!==scope.applicationId||r.recruitment_id!==scope.recruitmentId||
   r.attempt_id!==attemptId||r.definition_entry_id!==definitionId||!Number.isSafeInteger(r.version)||Number(r.version)<1)
   throw new Error('Niezgodne powiązanie oceny.');
  const evaluated=evaluateCompetencyTest(definition,{workSample:answer},r.observations);
  if(r.policy_version!==evaluated.policyVersion||Number(r.coverage)!==evaluated.coverage||r.status!==evaluated.status||
   (r.score===null?null:Number(r.score))!==evaluated.score)throw new Error('Niezgodna ocena.');
  return {...evaluated,version:Number(r.version)};
 }).sort((a,b)=>b.version-a.version);
 const review=reviews[0]??null;
 return {answer,review,confirmed:review?.criterionResults.filter(r=>r.rating!=='insufficient_data').map(r=>({...r,
  rationale:definition.criteria[r.criterionIndex][r.rating==='above'?'above':r.rating==='meets'?'meets':'below']}))??[],
  missing:review?review.criterionResults.filter(r=>r.rating==='insufficient_data').map(r=>r.competency):definition.criteria.map(r=>r.competency)};
}
export function competencyActionError(code?:string) {
 return code==='PT409'?'Stan zmienił się. Odśwież stronę i sprawdź status przed ponowieniem.':
  code==='PT422'?'Sprawdź termin i wymagane pola.':
  'Dostęp do testu jest niedostępny. Sprawdź uprawnienia, shortlistę i stan zgłoszenia.';
}
