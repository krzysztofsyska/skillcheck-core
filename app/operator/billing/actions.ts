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
  | 'sc19_operator_grant_paid' | 'sc19_operator_set_auto_free' | 'sc19_operator_release_trial_nip',
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

export async function grantPaid(form: FormData) {
  const search = searchOf(form);
  const input = parseGrantForm(form);
  if (!input) done('invalid', search);
  if (form.get('confirm') !== 'yes') done('confirm', search);
  await rpc('sc19_operator_grant_paid', input!, 'paid_granted', search);
}
