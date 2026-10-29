import 'server-only';
import type { Metadata } from 'next';
import Link from 'next/link';
import { salesOperator } from '../sales/access';
import { checkFakturowniaConnection, fakturowniaMessages, type FakturowniaFetch } from '../../../lib/fakturownia-client';
import styles from '../sales/sales.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Fakturownia — połączenie | SkillCheck', robots: { index: false, follow: false } };

const serverFetch: FakturowniaFetch = (url, init) => fetch(url, { ...init, cache: 'no-store', redirect: 'error' });

/** Owner-only, read-only diagnostics for SC-BILLING-INVOICE-001 (#165).
 * Lists issuing companies and counts this month's proformas; never issues,
 * sends or modifies any document and never renders the API token. */
export default async function FakturowniaPage() {
  await salesOperator();
  const health = await checkFakturowniaConnection(process.env, serverFetch);
  return <main className={styles.page}>
    <nav><Link href="/operator/sales">Proces sprzedaży</Link><Link href="/">Strona główna</Link></nav>
    <header><p className={styles.eyebrow}>SKILLCHECK · FAKTUROWNIA</p><h1>Połączenie z Fakturownią</h1>
      <p>Test tylko odczytuje dane. Nie wystawia, nie wysyła i nie zmienia żadnych dokumentów.</p></header>
    {health.ok ? <section className={styles.card} role="status">
      <h2>Połączenie działa</h2>
      <p>Konto: <strong>{health.account}.fakturownia.pl</strong></p>
      <p>Firmy wystawiające na koncie:</p>
      <ul>{health.departments.map(d => <li key={d.id}>{d.name || '(bez nazwy)'}{d.taxNo ? ` · NIP ${d.taxNo}` : ''} · ID działu {d.id}</li>)}</ul>
      {!health.departments.length && <p>Brak firm na koncie. Uzupełnij dane firmy w Ustawieniach Fakturowni.</p>}
      <p>Proformy wystawione w tym miesiącu: <strong>{health.proformasThisMonth}{health.proformasThisMonth >= 100 ? '+' : ''}</strong></p>
    </section> : <section className={styles.card} role="alert">
      <h2>Brak połączenia</h2>
      <p>{fakturowniaMessages[health.code]}</p>
      <p className={styles.hint}>Kod: {health.code}{health.httpStatus ? ` · HTTP ${health.httpStatus}` : ''}</p>
    </section>}
    <p className={styles.hint}>Zmienne FAKTUROWNIA_ACCOUNT i FAKTUROWNIA_API_TOKEN są czytane tylko po stronie serwera. Token nie jest nigdy wyświetlany.</p>
  </main>;
}
