'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { companyAccess } from '../../../../lib/company-access';
import { MARKETING_CONSENT_VERSION, type MarketingConsentNotice } from '../../../../lib/marketing-consent';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SC-CONSENT-001: the company's own one-click grant and withdrawal. Only the
 * owner may change it (the database re-checks), and both paths APPEND to the
 * ledger — a withdrawal never deletes or overwrites the grant, so the history
 * and the time of withdrawal are preserved. Nothing is sent to anyone here. */
async function change(form: FormData, op: 'grant' | 'withdraw') {
  const companyId = String(form.get('companyId') ?? '');
  if (!uuidPattern.test(companyId)) redirect('/dashboard');
  const { client, company, user } = await companyAccess(companyId);
  const back = (status: MarketingConsentNotice) => {
    revalidatePath(`/dashboard/${companyId}/zgody`);
    redirect(`/dashboard/${companyId}/zgody?status=${status}`);
  };
  if (user.id !== company.owner_id) back('failed');
  const { error } = op === 'grant'
    // No source argument: this RPC always records 'company_panel', which is
    // where the click happened. The provenance is not something a caller may
    // name — see public.marketing_consent_grant in the migration.
    ? await client.rpc('marketing_consent_grant', {
      target_company: companyId, consent_version: MARKETING_CONSENT_VERSION,
    })
    : await client.rpc('marketing_consent_withdraw', { target_company: companyId });
  // marketing_consent_not_active: nothing to withdraw; the state already matches.
  if (error) back(error.message?.includes('marketing_consent_not_active') ? 'unchanged' : 'failed');
  back(op === 'grant' ? 'granted' : 'withdrawn');
}

export async function grantMarketingConsent(form: FormData) { await change(form, 'grant'); }
export async function withdrawMarketingConsent(form: FormData) { await change(form, 'withdraw'); }
