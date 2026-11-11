import { notFound } from 'next/navigation';
import { companyAccess } from './company-access';
import { exerciseUuid, exerciseRecruitmentMatches, exercisePositionMatches } from './exercise-context-identity';
export { exerciseUuid } from './exercise-context-identity';
export async function exerciseContext(companyId: string, recruitmentId: string) {
  const access = await companyAccess(companyId);
  if (!exerciseUuid.test(recruitmentId)) notFound();
  const recruitment = await access.client.from('recruitments').select('*').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle();
  if (recruitment.error) throw new Error('Nie udało się wczytać rekrutacji.');
  if (!recruitment.data || !exerciseRecruitmentMatches(recruitment.data, companyId, recruitmentId)) notFound();
  const position = await access.client.from('positions').select('*').eq('company_id', companyId).eq('id', recruitment.data.position_id).maybeSingle();
  if (position.error) throw new Error('Nie udało się wczytać stanowiska.');
  if (!position.data || !exercisePositionMatches(position.data, companyId, recruitment.data.position_id)) notFound();
  return { ...access, recruitment: recruitment.data, position: position.data,
    editable: access.canEdit && ['draft', 'open'].includes(recruitment.data.status) && position.data.status !== 'archived',
    base: `/dashboard/${companyId}/recruitments/${recruitmentId}/exercises` };
}
