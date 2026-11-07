'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { companyAccess } from '../../../../lib/company-access';
import { activateFreeWithWhitelist, trialStore } from '../../../../lib/sc19-trial-auto-server';

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
  // SC-FREE-AUTO-001: an already approved company is granted straight away; an
  // unapproved one is checked in the Ministry of Finance VAT register and
  // granted only on a confirmed ACTIVE taxpayer. Everything else returns
  // 'manual' and leaves the company on the operator's list — no credits.
  const { status, decision } = await activateFreeWithWhitelist({ store: trialStore(client), companyId, nip });
  // Outcome only: never the NIP, the company name or the registry payload.
  if (decision) console.info('sc19_trial_auto', decision.outcome, decision.errorCode ?? '-');
  if (status !== 'activated') redirect(`/dashboard/${companyId}/billing?status=${status}`);
  revalidatePath(`/dashboard/${companyId}/billing`);
  redirect(`/dashboard/${companyId}/billing?status=activated`);
}
