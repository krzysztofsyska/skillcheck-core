'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '../../../lib/supabase/server';
import { aiCostError, parseFxForm, parseOtherCostForm, type AiCostNotice } from '../../../lib/ai-cost-dashboard';

const back = (form: FormData) => {
  const value = form.get('back');
  // Only the panel's own query string, never an arbitrary redirect target.
  return typeof value === 'string' && /^[a-zA-Z0-9=&_-]{0,200}$/.test(value) ? value : '';
};

const done = (status: AiCostNotice, query: string): never => {
  revalidatePath('/operator/ai-costs');
  const params = new URLSearchParams(query);
  params.set('status', status);
  redirect(`/operator/ai-costs?${params}`);
};

// Each RPC re-checks the current operator allowlist (including revocation) and every value.
async function rpc(name: 'sc021_operator_add_fx_rate' | 'sc021_operator_add_other_cost', args: Record<string, unknown>,
  success: AiCostNotice, query: string) {
  const client = await createClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) redirect('/login');
  const { error } = await client.rpc(name, args as never);
  if (error?.code === '42501') notFound();
  done(error ? aiCostError(error) : success, query);
}

export async function addFxRate(form: FormData) {
  const query = back(form);
  const input = parseFxForm(form);
  if (!input) done('invalid', query);
  if (form.get('confirm') !== 'yes') done('confirm', query);
  await rpc('sc021_operator_add_fx_rate', input!, 'fx_saved', query);
}

export async function addOtherCost(form: FormData) {
  const query = back(form);
  const input = parseOtherCostForm(form);
  if (!input) done('invalid', query);
  if (form.get('confirm') !== 'yes') done('confirm', query);
  await rpc('sc021_operator_add_other_cost', input!, 'cost_saved', query);
}
