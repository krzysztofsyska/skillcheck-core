'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { companyAccess } from '../../../../lib/company-access';

export async function activateSc19Free(form: FormData) {
  const companyId = String(form.get('companyId') ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
    redirect('/dashboard');
  }
  if (process.env.SC19_PACKAGES_ENABLED !== 'true') redirect('/dashboard');
  const { client, company, user } = await companyAccess(companyId);
  if (user.id !== company.owner_id) redirect(`/dashboard/${companyId}/billing?status=forbidden`);
  const nip = String(form.get('nip') ?? '').trim();
  if (nip.length > 20) redirect(`/dashboard/${companyId}/billing?status=invalid`);
  const { error } = await client.rpc('sc19_claim_trial', { target_company: companyId, supplied_nip: nip });
  if (error) {
    const status = error.code === '23505' ? 'taken' : error.code === '22023' ? 'invalid' : 'failed';
    redirect(`/dashboard/${companyId}/billing?status=${status}`);
  }
  revalidatePath(`/dashboard/${companyId}/billing`);
  redirect(`/dashboard/${companyId}/billing?status=activated`);
}
