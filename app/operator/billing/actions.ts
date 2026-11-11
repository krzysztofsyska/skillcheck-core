'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '../../../lib/supabase/server';
import { parseGrantForm, parsePolicyForm, parseReleaseForm, parseTrialForm, sc19OperatorError, type Sc19OperatorNotice } from '../../../lib/sc19-operator';

const done = (status: Sc19OperatorNotice, search = ''): never => {
  revalidatePath('/operator/billing');
  const query = new URLSearchParams({ status });
  if (search) query.set('q', search);
  redirect(`/operator/billing?${query}`);
};

// Every RPC re-checks the current operator allowlist, including revocation.
async function rpc(name: 'sc19_operator_set_package_policy' | 'sc19_operator_approve_trial'
  | 'sc19_operator_grant_paid' | 'sc19_operator_set_auto_free' | 'sc19_operator_release_trial_nip'
  | 'sc19_operator_publish_offer',
  args: Record<string, string | number | boolean>, success: Sc19OperatorNotice, search: string) {
  const client = await createClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) redirect('/login');
  const { error } = await client.rpc(name, args as never);
  if (error?.code === '42501') notFound();
  done(error ? sc19OperatorError(error) : success, search);
}

const searchOf = (form: FormData) => {
  const value = form.get('q');
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
};

export async function savePolicy(form: FormData) {
  const input = parsePolicyForm(form);
  if (!input) done('invalid');
  if (form.get('confirm') !== 'yes') done('confirm');
  await rpc('sc19_operator_set_package_policy', input!, 'policy_saved', '');
}

export async function approveTrial(form: FormData) {
  const search = searchOf(form);
  const input = parseTrialForm(form);
  if (!input) done('invalid', search);
  if (form.get('confirm') !== 'yes') done('confirm', search);
  await rpc('sc19_operator_approve_trial', input!, 'trial_approved', search);
}

/** SC-FREE-AUTO-001: the operator switch for automatic FREE. The database holds
 * the authoritative value (default off) and re-checks the operator role. */
export async function setAutoFree(form: FormData) {
  const value = form.get('enabled');
  if (value !== 'true' && value !== 'false') done('invalid');
  if (form.get('confirm') !== 'yes') done('confirm');
  await rpc('sc19_operator_set_auto_free', { enabled: value === 'true' }, 'auto_free_saved', '');
}

/** Frees a trial NIP that an account occupied without representing the company,
 * so the real company can activate FREE. The database re-checks the operator
 * role, demands a reason and records who released what, when and why. It changes
 * no balance: taking analyses back is a billing action and the owner's decision. */
export async function releaseTrialNip(form: FormData) {
  const search = searchOf(form);
  const input = parseReleaseForm(form);
  if (!input) done('invalid', search);
  if (form.get('confirm') !== 'yes') done('confirm', search);
  await rpc('sc19_operator_release_trial_nip', input!, 'nip_released', search);
}

/** SC-019 offer publication: makes the approved PRESELEKCJA package, its price
 * and its terms visible on the checkout page of a verified company. The offer
 * itself — price, number of CV analyses and the whole contract text — is a
 * reviewed constant in the database function, so there is nothing to parse here:
 * the operator decides whether to publish, never what. The database re-checks
 * the operator role, the price catalog and the granted quota, and refuses rather
 * than publish an offer that disagrees with either. */
export async function publishOffer(form: FormData) {
  if (form.get('confirm') !== 'yes') done('confirm');
  await rpc('sc19_operator_publish_offer', {}, 'offer_published', '');
}

/** SC-P24-DIAG-001: asks Przelewy24, read-only, whether they accept this
 * deployment's POS id and API key, and reports only the outcome.
 *
 * It re-checks the operator allowlist itself, because a server action is its own
 * endpoint and must never inherit the page's check. It takes no input, so there
 * is nothing an operator could point it at: the credentials come from the gate,
 * the address is the sandbox constant. It creates no transaction, charges
 * nobody, and the redirect carries one short code — never a key, a shape hint or
 * a connection string. */
export async function checkP24() {
  const client = await createClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) redirect('/login');
  const { data, error } = await client.rpc('platform_operator_status');
  if (error) throw new Error('Nie udało się sprawdzić dostępu.');
  if (data !== true) notFound();
  const { sc19P24Diagnostic, sc19P24DiagnosticCode } = await import('../../../lib/sc19-p24-diagnostic');
  const code = sc19P24DiagnosticCode(await sc19P24Diagnostic(process.env));
  revalidatePath('/operator/billing');
  redirect(`/operator/billing?${new URLSearchParams({ p24: code })}`);
}

export async function grantPaid(form: FormData) {
  const search = searchOf(form);
  const input = parseGrantForm(form);
  if (!input) done('invalid', search);
  if (form.get('confirm') !== 'yes') done('confirm', search);
  await rpc('sc19_operator_grant_paid', input!, 'paid_granted', search);
}
