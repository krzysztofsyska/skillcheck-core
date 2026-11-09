'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { companyAccess } from '../../../../lib/company-access';
import { checkClaim, tenantDomainsEnabled } from '../../../../lib/tenant-domains';
import { checkDomain } from '../../../../lib/tenant-domain-verifier';
import { systemDnsResolver, systemTlsChecker, verifierStoreFromEnv } from '../../../../lib/tenant-domain-network';
import type { DomainNotice } from './notices';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** SC-020-B: zarządzanie domenami — tylko właściciel firmy (baza sprawdza ponownie). */
async function ownerContext(form: FormData) {
  if (!tenantDomainsEnabled(process.env)) notFound();
  const companyId = String(form.get('companyId') ?? '');
  if (!uuidPattern.test(companyId)) redirect('/dashboard');
  const access = await companyAccess(companyId);
  const back = (status: DomainNotice): never => {
    revalidatePath(`/dashboard/${companyId}/domeny`);
    redirect(`/dashboard/${companyId}/domeny?status=${status}`);
  };
  if (access.user.id !== access.company.owner_id) back('failed');
  return { ...access, companyId, back };
}

function claimError(message: string | undefined): DomainNotice {
  if (!message) return 'failed';
  if (message.includes('tenant_domain_invalid')) return 'invalid';
  if (message.includes('tenant_domain_reserved')) return 'reserved';
  if (message.includes('tenant_domain_taken') || message.includes('tenant_domain_already_claimed')) return 'taken';
  if (message.includes('tenant_domain_limit')) return 'limit';
  if (message.includes('tenant_domain_subdomains_disabled')) return 'subdomains_disabled';
  return 'failed';
}

export async function claimDomain(form: FormData) {
  const { client, companyId, back } = await ownerContext(form);
  const kind = form.get('kind') === 'subdomain' ? 'subdomain' : 'custom';
  const { data: state, error: stateError } = await client.rpc('tenant_domain_state', { target_company: companyId });
  if (stateError) back('failed');
  const base = (state as { subdomain_base?: string | null } | null)?.subdomain_base ?? null;
  const checked = checkClaim(form.get('hostname'), kind, base);
  if (!checked.ok) back(checked.reason);
  const hostname = (checked as { hostname: string }).hostname;
  const { error } = await client.rpc('tenant_domain_claim', { target_company: companyId, target_hostname: hostname, target_kind: kind });
  if (error) back(claimError(error.message));
  back('claimed');
}

async function domainId(form: FormData, back: (status: DomainNotice) => never) {
  const id = String(form.get('domainId') ?? '');
  if (!uuidPattern.test(id)) back('failed');
  return id;
}

export async function verifyDomain(form: FormData) {
  const { client, companyId, back, user } = await ownerContext(form);
  const id = await domainId(form, back);
  // Uprawnienie potwierdza klient RLS (tylko właściciel odczyta stan); dopiero
  // potem połączenie weryfikatora, które czyta host i token z bazy.
  const { data: state, error } = await client.rpc('tenant_domain_state', { target_company: companyId });
  if (error) back('failed');
  const domains = ((state as { domains?: { id: string }[] } | null)?.domains ?? []);
  if (!domains.some(d => d.id === id)) back('failed');
  const store = verifierStoreFromEnv();
  if (!store) back('verifier_unavailable');
  let outcome: Awaited<ReturnType<typeof checkDomain>> | null = null;
  try {
    outcome = await checkDomain({ store: store!, dns: systemDnsResolver, tls: systemTlsChecker }, companyId, id, user.id);
  } catch {
    outcome = null;
  }
  if (!outcome || outcome.result === 'not_found') back('failed');
  else if (outcome.result === 'checked') back(outcome.tls ? 'ready' : outcome.status === 'pending' ? 'dns_missing' : 'tls_pending');
  else back(outcome.result);
}

async function transition(form: FormData, fn: 'tenant_domain_activate' | 'tenant_domain_deactivate' | 'tenant_domain_revoke', ok: DomainNotice) {
  const { client, companyId, back } = await ownerContext(form);
  const id = await domainId(form, back);
  const { error } = await client.rpc(fn, { target_company: companyId, target_domain: id });
  if (error) back(error.message?.includes('tenant_domain_not_ready') ? 'not_ready' : 'failed');
  back(ok);
}

export async function activateDomain(form: FormData) { await transition(form, 'tenant_domain_activate', 'activated'); }
export async function deactivateDomain(form: FormData) { await transition(form, 'tenant_domain_deactivate', 'deactivated'); }
export async function revokeDomain(form: FormData) { await transition(form, 'tenant_domain_revoke', 'revoked'); }
