/**
 * SC-020-B — sprawdzenie domeny (DNS TXT, potem TLS) i zapis wyniku przez
 * rolę bazy `tenant_domain_verifier`. Wyłącznie serwer.
 *
 * Wywołujący MUSI wcześniej potwierdzić, że użytkownik jest właścicielem firmy
 * (klient RLS: public.tenant_domain_state). Ta warstwa nie ufa niczemu z
 * żądania poza identyfikatorami firmy i domeny; host i token czyta z bazy.
 */
import { checkDnsOwnership, isValidHostname, type DnsTxtResolver, type TlsReadinessChecker } from './tenant-domains.ts';

export interface VerifierStore {
  target(companyId: string, domainId: string): Promise<{ hostname: string; kind: string; status: string; verification_token: string } | null>;
  recordDns(companyId: string, domainId: string, token: string, ok: boolean): Promise<string>;
  recordTls(companyId: string, domainId: string, token: string, ok: boolean): Promise<string>;
}

export type DomainCheckOutcome =
  | { result: 'not_found' }
  | { result: 'dns_unavailable'; status: string }
  | { result: 'dns_missing'; status: string }
  | { result: 'conflict' }
  | { result: 'checked'; status: string; tls: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function checkDomain(
  deps: { store: VerifierStore; dns: DnsTxtResolver; tls: TlsReadinessChecker },
  companyId: string, domainId: string,
): Promise<DomainCheckOutcome> {
  if (!UUID.test(companyId) || !UUID.test(domainId)) return { result: 'not_found' };
  const target = await deps.store.target(companyId, domainId);
  if (!target || !isValidHostname(target.hostname)) return { result: 'not_found' };
  let status = target.status;
  if (target.kind === 'custom') {
    const dns = await checkDnsOwnership(deps.dns, target.hostname, target.verification_token);
    // Awaria resolvera nie jest dowodem braku rekordu: nic nie zapisujemy.
    if (dns === 'unavailable') return { result: 'dns_unavailable', status };
    status = await deps.store.recordDns(companyId, domainId, target.verification_token, dns === 'ok');
    if (status === 'conflict') return { result: 'conflict' };
    if (dns === 'missing') return { result: 'dns_missing', status };
  }
  if (status !== 'verified' && status !== 'active') return { result: 'checked', status, tls: false };
  let tls = false;
  try {
    tls = await deps.tls.isReady(target.hostname);
  } catch {
    tls = false;
  }
  status = await deps.store.recordTls(companyId, domainId, target.verification_token, tls);
  return { result: 'checked', status, tls };
}
