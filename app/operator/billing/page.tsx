import 'server-only';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { salesOperator } from '../sales/access';
import { sc19OperatorNotices } from '../../../lib/sc19-operator';
import { approveTrial, grantPaid, savePolicy } from './actions';
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
  const [policy, companies] = await Promise.all([
    client.rpc('sc19_operator_package_policy'),
    client.rpc('sc19_operator_companies', { search: search || null }),
  ]);
  if (policy.error?.code === '42501' || companies.error?.code === '42501') notFound();
  if (policy.error || companies.error || !policy.data || !companies.data) throw new Error('Nie udało się odczytać pakietów.');
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
