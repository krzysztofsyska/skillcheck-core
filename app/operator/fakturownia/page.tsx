import 'server-only';
import type { Metadata } from 'next';
import Link from 'next/link';
import { salesOperator } from '../sales/access';
import { checkFakturowniaConnection, fakturowniaMessages, type FakturowniaFetch } from '../../../lib/fakturownia-client';
import { loadInvoicesToReview, type InvoiceReviewResult } from '../../../lib/sc19-stripe-invoice-review-runtime';
import styles from '../sales/sales.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Fakturownia — połączenie | SkillCheck', robots: { index: false, follow: false } };

const dates = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' });
const when = (ms: number | null) => ms === null || !Number.isFinite(ms) ? 'nieznany' : dates.format(new Date(ms));
const pln = (minor: number) => `${(minor / 100).toFixed(2).replace('.', ',')} zł`;
const statusLabel: Record<string, string> = { failed: 'błąd', new: 'nie rozpoczęta', pending: 'utknęła w trakcie' };

/** R7: LIVE Stripe invoices and corrections not issued (read only; follow-up to #594). */
function InvoicesToReview({ review }: { review: InvoiceReviewResult }) {
  if (review.state === 'not_configured') return <section className={styles.card} aria-labelledby="review">
    <h2 id="review">Faktury do sprawdzenia</h2>
    <p>Płatności Stripe nie są skonfigurowane na tym wdrożeniu, więc nie ma faktur do sprawdzenia.</p></section>;
  if (review.state === 'not_installed') return <section className={styles.card} aria-labelledby="review">
    <h2 id="review">Faktury do sprawdzenia</h2>
    <p>Funkcja faktur na żywo nie jest jeszcze włączona w bazie.</p></section>;
  if (review.state === 'unavailable') return <section className={styles.card} role="alert" aria-labelledby="review">
    <h2 id="review">Faktury do sprawdzenia</h2>
    <p>Nie udało się odczytać faktur do sprawdzenia. Odśwież stronę — to nie znaczy, że wszystkie są wystawione.</p></section>;
  if (!review.total) return <section className={styles.card} role="status" aria-labelledby="review">
    <h2 id="review">Faktury do sprawdzenia</h2><p className={styles.empty}>Brak faktur do sprawdzenia.</p></section>;
  return <section className={styles.card} role="alert" aria-labelledby="review">
    <h2 id="review">Faktury do sprawdzenia: {review.total}{review.truncated ? '+' : ''}</h2>
    <p>Płatności na żywo bez wystawionej faktury VAT albo korekty (błąd lub brak postępu od ponad godziny). Wyślij zdarzenie
      ponownie z panelu Stripe (Webhooks → zdarzenie → Resend) albo wystaw dokument ręcznie w Fakturowni.</p>
    <ul className={styles.list}>{review.items.map(i => <li key={`${i.kind}:${i.orderId}:${i.refundedTotalMinor ?? ''}`}>
      <strong>{i.kind === 'invoice' ? 'Faktura VAT' : `Korekta (zwrot łącznie ${pln(i.refundedTotalMinor ?? 0)})`}</strong>
      {' · '}{statusLabel[i.status] ?? i.status}{i.errorCode ? ` · kod: ${i.errorCode}` : ''} · prób: {i.attempts}
      <br /><span className={styles.hint}>Zamówienie {i.orderId} · płatność Stripe {i.paymentId}</span>
      <br /><span className={styles.hint}>Pierwsza próba: {when(i.firstAttemptMs)} · ostatnia próba: {when(i.lastAttemptMs)}
        · ostatnia zmiana: {when(i.changedAtMs)}</span>
    </li>)}</ul>
  </section>;
}

const serverFetch: FakturowniaFetch = (url, init) => fetch(url, { ...init, cache: 'no-store', redirect: 'error' });

/** Owner-only, read-only diagnostics for SC-BILLING-INVOICE-001 (#165), and (R7) the
 * LIVE Stripe invoices and corrections still waiting to be issued.
 * Lists issuing companies and counts this month's proformas; never issues,
 * sends or modifies any document and never renders the API token. */
export default async function FakturowniaPage() {
  await salesOperator();
  const [health, review] = await Promise.all([checkFakturowniaConnection(process.env, serverFetch), loadInvoicesToReview()]);
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
    <InvoicesToReview review={review} />
    <p className={styles.hint}>Zmienne FAKTUROWNIA_ACCOUNT i FAKTUROWNIA_API_TOKEN są czytane tylko po stronie serwera. Token nie jest nigdy wyświetlany.</p>
  </main>;
}
