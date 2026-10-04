import { notFound } from 'next/navigation';
import { companyAccess } from './company-access';
export const exerciseUuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export async function exerciseContext(companyId: string, recruitmentId: string) {
  const access = await companyAccess(companyId);
  if (!exerciseUuid.test(recruitmentId)) notFound();
  const recruitment = await access.client.from('recruitments').select('*').eq('company_id', companyId).eq('id', recruitmentId).maybeSingle();
  if (recruitment.error) throw new Error('Nie udało się wczytać rekrutacji.');
  if (!recruitment.data) notFound();
  const position = await access.client.from('positions').select('*').eq('company_id', companyId).eq('id', recruitment.data.position_id).maybeSingle();
  if (position.error) throw new Error('Nie udało się wczytać stanowiska.');
  if (!position.data) notFound();
  return { ...access, recruitment: recruitment.data, position: position.data,
    editable: access.canEdit && ['draft', 'open'].includes(recruitment.data.status) && position.data.status !== 'archived',
    base: `/dashboard/${companyId}/recruitments/${recruitmentId}/exercises` };
}
