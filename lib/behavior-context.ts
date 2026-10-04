import { notFound } from 'next/navigation';
import { companyAccess } from './company-access';

export type BehaviorRoute = { companyId: string; recruitmentId: string; applicationId: string };
export async function loadBehaviorContext({ companyId, recruitmentId, applicationId }: BehaviorRoute) {
  const access = await companyAccess(companyId);
  if (![recruitmentId, applicationId].every(id => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) notFound();
  const { client } = access;
  const application = await client.from('applications').select('*').eq('company_id', companyId)
    .eq('recruitment_id', recruitmentId).eq('id', applicationId).maybeSingle();
  if (application.error) throw new Error('Nie udało się wczytać zgłoszenia.');
  if (!application.data) notFound();
  const [recruitment, candidate] = await Promise.all([
    client.from('recruitments').select('*').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle(),
    client.from('candidates').select('first_name,last_name').eq('company_id', companyId).eq('id', application.data.candidate_id).maybeSingle(),
  ]);
  if (recruitment.error || candidate.error) throw new Error('Nie udało się wczytać rekrutacji.');
  if (!recruitment.data || !candidate.data) notFound();
  const position = await client.from('positions').select('*').eq('company_id', companyId).eq('id', recruitment.data.position_id).maybeSingle();
  if (position.error) throw new Error('Nie udało się wczytać wymagań stanowiska.');
  if (!position.data) notFound();
  return { ...access, application: application.data, recruitment: recruitment.data, candidate: candidate.data, position: position.data,
    base: `/dashboard/${companyId}/recruitments/${recruitmentId}/applications/${applicationId}/behaviors` };
}
