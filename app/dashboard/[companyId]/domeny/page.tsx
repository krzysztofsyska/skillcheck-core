import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { companyAccess } from '../../../../lib/company-access';
import { tenantDomainsEnabled, verificationRecord } from '../../../../lib/tenant-domains';
import { activateDomain, claimDomain, deactivateDomain, revokeDomain, verifyDomain } from './actions';
import { domainNotices } from './notices';

export const metadata: Metadata = { title: 'Domeny' };

type DomainRow = {
  id: string; hostname: string; kind: 'subdomain' | 'custom'; status: 'pending' | 'verified' | 'active' | 'revoked';
  verification_token: string | null; pending_expires_at: string | null; last_verified_at: string | null;
  fresh: boolean; tls_ready_at: string | null; revoke_reason: string | null; created_at: string;
};
type DomainEvent = { domain_id: string; action: string; by_owner: boolean; at: string };
type DomainState = { subdomain_base: string | null; reverify_days: number; domains: DomainRow[]; events: DomainEvent[] };

const dates = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' });
const statusLabel = { pending: 'czeka na weryfikację', verified: 'zweryfikowana', active: 'włączona', revoked: 'odwołana' } as const;
const actionLabel: Record<string, string> = {
  claimed: 'dodano', verified: 'potwierdzono DNS', verification_failed: 'nie znaleziono rekordu DNS', reverified: 'ponownie potwierdzono DNS',
  verification_lapsed: 'weryfikacja wygasła — wymagana ponowna', verification_conflict: 'domena potwierdzona przez inne konto',
  tls_ready: 'certyfikat gotowy', tls_failed: 'certyfikat niegotowy', activated: 'włączono', deactivated: 'wyłączono',
  revoked: 'odwołano', expired: 'zgłoszenie wygasło',
};

/** SC-020-B: domeny firmy (subdomena platformy lub własna domena). Tylko właściciel. */
export default async function CompanyDomains({ params, searchParams }: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  if (!tenantDomainsEnabled(process.env)) notFound();
  const { companyId } = await params;
  const { client, company, user } = await companyAccess(companyId);
  const { status } = await searchParams;
  const isOwner = user.id === company.owner_id;
  const back = <Link href={`/dashboard/${companyId}`}>← Panel firmy</Link>;
  if (!isOwner) {
    return <main className="workspace"><section>{back}<h1>Domeny — {company.name}</h1>
      <p className="notice">Domenami firmy zarządza właściciel konta.</p></section></main>;
  }
  const { data, error } = await client.rpc('tenant_domain_state', { target_company: companyId });
  if (error) {
    return <main className="workspace"><section>{back}<h1>Domeny — {company.name}</h1>
      <p className="notice">Zarządzanie domenami nie jest jeszcze dostępne w tym środowisku.</p></section></main>;
  }
  const state = data as unknown as DomainState;
  const hidden = (id: string) => <><input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="domainId" value={id} /></>;
  const hosts = new Map(state.domains.map(d => [d.id, d.hostname]));
  const now = Date.now();

  return <main className="workspace"><section>
    {back}
    <h1>Domeny — {company.name}</h1>
    {status && Object.hasOwn(domainNotices, status) && <p role="status" className="notice">{domainNotices[status as keyof typeof domainNotices]}</p>}
    <p>Panel firmy może działać pod Twoim adresem, np. <code>kariera.twojafirma.pl</code>. Najpierw potwierdzasz, że domena należy
      do Ciebie (rekord DNS), potem sprawdzamy certyfikat, a na końcu włączasz domenę. Domenę trzeba też skierować na naszą
      platformę — tę część konfigurujemy razem z Tobą.</p>

    <section aria-labelledby="add">
      <h2 id="add">Dodaj domenę</h2>
      <form action={claimDomain}>
        <input type="hidden" name="companyId" value={companyId} />
        <label>Adres <input name="hostname" required maxLength={253} placeholder="kariera.twojafirma.pl" autoComplete="off" /></label>
        {state.subdomain_base
          ? <label>Rodzaj <select name="kind" defaultValue="custom">
              <option value="custom">Własna domena</option>
              <option value="subdomain">Subdomena .{state.subdomain_base} (wpisz tylko pierwszą część)</option>
            </select></label>
          : <input type="hidden" name="kind" value="custom" />}
        <button type="submit" className="button">Dodaj</button>
      </form>
    </section>

    <section aria-labelledby="list">
      <h2 id="list">Twoje domeny</h2>
      {state.domains.length === 0 ? <p>Nie dodano jeszcze żadnej domeny.</p> : <ul>
        {state.domains.map(d => {
          const record = d.kind === 'custom' && d.verification_token && d.status !== 'revoked' ? verificationRecord(d.hostname, d.verification_token) : null;
          return <li key={d.id}>
            <p><strong>{d.hostname}</strong> — {statusLabel[d.status]}{d.kind === 'subdomain' ? ' (subdomena platformy)' : ''}
              {d.status === 'active' && !d.fresh ? ' — wymaga ponownej weryfikacji DNS' : ''}</p>
            {d.status === 'pending' && record && <div>
              <p>Dodaj u swojego dostawcy DNS rekord <strong>TXT</strong>:</p>
              <p>Nazwa: <code>{record.name}</code></p>
              <p>Wartość: <code>{record.value}</code></p>
              {d.pending_expires_at && <p>Zgłoszenie ważne do {dates.format(new Date(d.pending_expires_at))}.</p>}
            </div>}
            {d.kind === 'custom' && d.status !== 'revoked' && <p>Rekord DNS zostaw na stałe. Kliknij „Sprawdź” co najmniej raz na {state.reverify_days} dni —
              bez tego domena przestanie działać i panel wróci na adres platformy.</p>}
            {d.kind === 'custom' && (d.status === 'verified' || d.status === 'active') && d.last_verified_at && (() => {
              const due = new Date(d.last_verified_at).getTime() + state.reverify_days * 86_400_000;
              const left = Math.ceil((due - now) / 86_400_000);
              return left <= 7 ? <p className="notice">{left > 0 ? `Weryfikacja wygasa za ${left} d. (${dates.format(new Date(due))}) — kliknij „Sprawdź”.` : 'Weryfikacja wygasła — kliknij „Sprawdź”, aby domena znów działała.'}</p> : null;
            })()}
            {d.status !== 'revoked' && <div className="actions">
              <form action={verifyDomain}>{hidden(d.id)}<button type="submit" className="button">Sprawdź</button></form>
              {d.status === 'verified' && d.tls_ready_at && <form action={activateDomain}>{hidden(d.id)}<button type="submit" className="button">Włącz</button></form>}
              {d.status === 'active' && <form action={deactivateDomain}>{hidden(d.id)}<button type="submit" className="button">Wyłącz</button></form>}
              <form action={revokeDomain}>{hidden(d.id)}<button type="submit" className="button">Odwołaj</button></form>
            </div>}
          </li>;
        })}
      </ul>}
    </section>

    {state.events.length > 0 && <section aria-labelledby="log">
      <h2 id="log">Historia zmian</h2>
      <ul>{state.events.map((e, i) => <li key={i}>{dates.format(new Date(e.at))} — {hosts.get(e.domain_id) ?? 'domena'}: {actionLabel[e.action] ?? e.action}{e.by_owner ? ' (właściciel)' : ' (automatycznie)'}</li>)}</ul>
    </section>}
  </section></main>;
}
