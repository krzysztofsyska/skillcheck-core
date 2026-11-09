/**
 * SC-020-D — cykliczna ponowna weryfikacja DNS własnych domen (projekt + kod,
 * bez uruchomienia). Zadanie czyta listę domen, którym zbliża się termin
 * (tenant_domains.reverify_due), sprawdza rekord TXT i zapisuje wynik
 * (tenant_domains.record_scheduled_dns_check)
 *
 * — wyłącznie przez OSOBNĄ rolę `tenant_domain_reverifier` i osobny adres
 * TENANT_DOMAIN_REVERIFY_DATABASE_URL, nigdy przez poświadczenie aplikacji
 * webowej (`tenant_domain_verifier`), żeby jego wyciek nie pozwalał odnawiać
 * domen bez właściciela.
 *
 * Fail closed: bez WHITE_LABEL (lib/white-label-flag.ts), bez
 * TENANT_DOMAIN_REVERIFY_ENABLED=true albo bez połączenia
 * (TENANT_DOMAIN_REVERIFY_DATABASE_URL) zadanie nic nie robi i zwraca
 * 'unconfigured'. Login roli, sekret i harmonogram (cron) to decyzja
 * operatora/właściciela; ten moduł ich nie tworzy.
 *
 * Awaria resolvera DNS ('unavailable') nie jest dowodem braku rekordu: nic
 * nie zapisujemy, żeby awaria sieci nie wyłączała domen klientów.
 */
import { checkDnsOwnership, isValidHostname, type DnsTxtResolver } from './tenant-domains.ts';
import { whiteLabelEnabled, type WhiteLabelEnvironment } from './white-label-flag.ts';

export type ReverifyTarget = { company_id: string; domain_id: string; hostname: string; verification_token: string };
export interface ReverifyStore {
  due(limit: number): Promise<ReverifyTarget[]>;
  record(companyId: string, domainId: string, token: string, ok: boolean): Promise<string>;
  /** Zamknięcie połączenia po przebiegu (jedna pula na cały przebieg). */
  close?(): Promise<void>;
}
export type ReverifySummary = {
  status: 'done'; checked: number; renewed: number; failed: number; lapsed: number; unavailable: number; skipped: number; errors: number;
};
export type ReverifyResult = ReverifySummary | { status: 'unconfigured' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;

export function reverifyEnabled(env: WhiteLabelEnvironment): boolean {
  return whiteLabelEnabled(env) && env['TENANT_DOMAIN_REVERIFY_ENABLED'] === 'true';
}

/** Jeden przebieg zadania. Błąd jednej domeny nie zatrzymuje pozostałych. */
export async function reverifyDueDomains(
  deps: { store: ReverifyStore | null; dns: DnsTxtResolver; env: WhiteLabelEnvironment },
  options: { limit?: number; timeoutMs?: number } = {},
): Promise<ReverifyResult> {
  if (!deps.store || !reverifyEnabled(deps.env)) {
    await deps.store?.close?.();
    return { status: 'unconfigured' };
  }
  try {
    return await runPass(deps.store, deps.dns, options);
  } finally {
    await deps.store.close?.();
  }
}

async function runPass(store: ReverifyStore, dns: DnsTxtResolver, options: { limit?: number; timeoutMs?: number }): Promise<ReverifySummary> {
  const deps = { store, dns };
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const summary: ReverifySummary = { status: 'done', checked: 0, renewed: 0, failed: 0, lapsed: 0, unavailable: 0, skipped: 0, errors: 0 };
  const targets = await deps.store.due(limit);
  for (const target of targets.slice(0, limit)) {
    if (!UUID.test(target.company_id) || !UUID.test(target.domain_id) || !isValidHostname(target.hostname) || !TOKEN.test(target.verification_token)) {
      summary.errors += 1;
      continue;
    }
    summary.checked += 1;
    try {
      const dns = await checkDnsOwnership(deps.dns, target.hostname, target.verification_token, options.timeoutMs);
      if (dns === 'unavailable') { summary.unavailable += 1; continue; }
      const status = await deps.store.record(target.company_id, target.domain_id, target.verification_token, dns === 'ok');
      // An already expired domain is never renewed by the job: it returns 'pending' even with the record present.
      if (status === 'skipped') summary.skipped += 1;
      else if (status === 'pending') summary.lapsed += 1;
      else if (dns === 'ok') summary.renewed += 1;
      else summary.failed += 1;
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
}
