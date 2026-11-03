import 'server-only';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { salesOperator } from '../sales/access';
import { sc19OperatorNotices } from '../../../lib/sc19-operator';
import { approveTrial, grantPaid, savePolicy, setAutoFree } from './actions';
import styles from '../sales/sales.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Pakiety firm | SkillCheck', robots: { index: false, follow: false } };

const dates = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' });

/** SC-019 operator fulfillment: package policy, FREE verification and paid
 * PRESELEKCJA grants. Payment is confirmed outside the browser; this panel
 * only records the operator's decision through audited RPCs. */
export default async function OperatorBillingPage({ searchParams }: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const client = await salesOperator();
  const { status, q } = await searchParams;
  const search = (q ?? '').trim().slice(0, 200);
  const [policy, companies, consents, autoGrants, autoSettings] = await Promise.all([
    client.rpc('sc19_operator_package_policy'),
    client.rpc('sc19_operator_companies', { search: search || null }),
    client.rpc('sc19_operator_marketing_consents', { search: search || null }),
    client.rpc('sc19_operator_auto_free_grants'),
    client.rpc('sc19_operator_auto_free_settings'),
  ]);
  if (policy.error?.code === '42501' || companies.error?.code === '42501') notFound();
  if (policy.error || companies.error || !policy.data || !companies.data) throw new Error('Nie udało się odczytać pakietów.');
  // Consent and automatic-FREE reporting is additional information: a failure
  // there must not hide the package panel the operator needs to do their job.
  const consentByCompany = new Map((consents.data ?? []).map(row => [row.company_id, row]));
  const autoFree = autoGrants.data ?? [];
  const auto = autoSettings.data?.[0] ?? null;
  const credits = Object.fromEntries(policy.data.map(row => [row.plan, row.credits]));
  const notice = status && Object.hasOwn(sc19OperatorNotices, status) ? sc19OperatorNotices[status as keyof typeof sc19OperatorNotices] : null;

  return <main className={styles.page}>
    <nav><Link href="/operator/sales">Proces sprzedaży</Link><Link href="/operator/leads">Zgłoszenia</Link><Link href="/">Strona główna</Link></nav>
    <header><p className={styles.eyebrow}>SKILLCHECK · PAKIETY</p><h1>Pakiety firm</h1>
      <p>Weryfikacja firm przed FREE i przydział PRESELEKCJI po potwierdzonej wpłacie. Każda operacja jest sprawdzana w bazie i zapisywana w dzienniku analiz.</p></header>
    {notice && <p role="status" className={styles.empty}>{notice}</p>}

    <section className={styles.card} aria-labelledby="policy">
      <h2 id="policy">Liczba analiz w pakietach</h2>
      {!policy.data.length && <p>Pakiety nie są jeszcze skonfigurowane. Bez tego FREE ani PRESELEKCJA nie przydzielą analiz.</p>}
      <ul>{policy.data.map(row => <li key={row.plan}><strong>{row.plan}</strong>: {row.credits} analiz CV · zmieniono {dates.format(new Date(row.updated_at))}</li>)}</ul>
      <form action={savePolicy} className={styles.form}>
        <label>Pakiet <select name="plan" defaultValue="FREE"><option value="FREE">FREE</option><option value="PRESELEKCJA">PRESELEKCJA</option></select></label>
        <label>Liczba analiz CV <input name="credits" type="number" min={1} max={100000} required /></label>
        <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Zmiana dotyczy kolejnych aktywacji i przydziałów, nie istniejących sald.</label>
        <button type="submit">Zapisz</button>
      </form>
    </section>

    {/* SC-FREE-AUTO-001: the switch and the record of what it did. Turning it
        on changes who may receive FREE without an operator, so it is an
        operator action with an explicit confirmation. */}
    <section className={styles.card} aria-labelledby="auto-free">
      <h2 id="auto-free">Automatyczne FREE z wykazu VAT</h2>
      {auto ? <p>Automat jest <strong>{auto.auto_free_enabled ? 'włączony' : 'wyłączony'}</strong>
        {auto.secret_configured ? '' : ' · brak klucza podpisu na serwerze, więc i tak nic nie przyzna'}
        {auto.updated_at ? ` · zmieniono ${dates.format(new Date(auto.updated_at))}` : ''}</p>
        : <p>Nie udało się odczytać ustawień automatu.</p>}
      <p className={styles.hint}>Przy włączonym automacie firma dostaje FREE tylko wtedy, gdy wykaz podatników VAT
        potwierdzi, że NIP istnieje i jest czynnym podatnikiem. Każda inna odpowiedź, brak odpowiedzi lub błąd
        oznacza brak przyznania i ręczne sprawdzenie poniżej.</p>
      <form action={setAutoFree} className={styles.form}>
        <label>Automat <select name="enabled" defaultValue={auto?.auto_free_enabled ? 'false' : 'true'}>
          <option value="true">włącz</option><option value="false">wyłącz</option></select></label>
        <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Rozumiem, że przy włączonym automacie FREE przyznaje się bez udziału operatora.</label>
        <button type="submit">Zapisz</button>
      </form>
    </section>

    <section aria-labelledby="auto-free-list">
      <h2 id="auto-free-list">Firmy z FREE przyznanym automatycznie</h2>
      <p className={styles.hint}>Do 200 firm, od najnowszej. Źródłem decyzji był wykaz podatników VAT, nie operator.</p>
      {!autoFree.length ? <p className={styles.empty}>Żadna firma nie dostała jeszcze FREE automatycznie.</p>
        : <ol className={styles.list}>{autoFree.map(row => <li key={`${row.company_id}-${row.granted_at}`} className={styles.card}>
          <div className={styles.cardTitle}><h3>{row.company_name}</h3>
            <span className={styles.badge}>{row.granted_credits ?? 0} przyznanych · {row.used_credits ?? 0} zużytych</span></div>
          <p className={styles.hint}>NIP {row.nip} · {dates.format(new Date(row.granted_at))} · status w wykazie: {row.mf_status ?? '—'}</p>
        </li>)}</ol>}
    </section>

    <section aria-labelledby="companies">
      <h2 id="companies">Firmy</h2>
      <form method="get" className={styles.filters}>
        <label>Nazwa firmy lub ID <input name="q" defaultValue={search} maxLength={200} /></label>
        <button type="submit">Szukaj</button>
      </form>
      <p className={styles.hint}>Do 200 firm, od najnowszej.</p>
      {!companies.data.length ? <p className={styles.empty}>Brak firm.</p> : <ol className={styles.list}>
        {companies.data.map(company => <li key={company.company_id} className={styles.card}>
          <div className={styles.cardTitle}><h2>{company.company_name}</h2>
            <span className={styles.badge}>{company.plan ? `${company.plan} · ${company.available} analiz` : 'Brak pakietu'}</span></div>
          <p className={styles.hint}>ID {company.company_id} · utworzona {dates.format(new Date(company.created_at))}</p>
          {/* SC-CONSENT-001: consent state per company. The wording is not
              repeated here; the operator needs the state and the time. */}
          <p className={styles.hint}>Zgoda na kontakt handlowy: {(() => {
            const consent = consentByCompany.get(company.company_id);
            if (!consent) return 'nie wyrażona';
            return `${consent.event === 'granted' ? 'aktywna' : 'wycofana'} · ${consent.consent_version} · ${dates.format(new Date(consent.occurred_at))}`;
          })()}</p>
          {company.approved_nip
            ? <p>Zweryfikowana: NIP {company.approved_nip}{company.approved_at ? ` · ${dates.format(new Date(company.approved_at))}` : ''}{company.free_claimed ? ' · FREE aktywowany' : ' · FREE czeka na aktywację przez właściciela'}</p>
            : <details><summary>Zweryfikuj firmę przed FREE</summary>
              <form action={approveTrial} className={styles.form}>
                <input type="hidden" name="companyId" value={company.company_id} />
                <input type="hidden" name="q" value={search} />
                <label>NIP firmy <input name="nip" inputMode="numeric" maxLength={13} required /></label>
                <label>Dowód weryfikacji (np. numer KRS/CEIDG i data sprawdzenia) <input name="proof" minLength={8} maxLength={100} required /></label>
                <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Zweryfikowano, że zgłaszający reprezentuje firmę o tym NIP.</label>
                <button type="submit">Zatwierdź weryfikację</button>
              </form></details>}
          <details><summary>Przydziel PRESELEKCJĘ po wpłacie{credits.PRESELEKCJA ? ` (${credits.PRESELEKCJA} analiz)` : ''}</summary>
            <form action={grantPaid} className={styles.form}>
              <input type="hidden" name="companyId" value={company.company_id} />
              <input type="hidden" name="q" value={search} />
              <label>Numer rozliczenia (np. numer faktury lub transakcji) <input name="settlement" minLength={8} maxLength={160} required /></label>
              <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Wpłata jest zaksięgowana i potwierdzona poza przeglądarką klienta.</label>
              <button type="submit">Przydziel pakiet</button>
            </form></details>
        </li>)}
      </ol>}
    </section>
  </main>;
}
