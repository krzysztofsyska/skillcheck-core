import 'server-only';
import type { Metadata } from 'next';
import Link from 'next/link';
import { pricingOwner } from './access';
import { InternalCalculator } from './internal-calculator';
import styles from './pricing.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Wewnętrzny kalkulator cen | SkillCheck', robots: { index: false, follow: false } };

/** Owner-only internal pricing calculator (prototype for #143/#144). Prices go through the
 * SC-PRICING-003 quote engine; costs and margins stay in this browser and are never sent anywhere.
 * Not connected to the customer-facing page, calculator or checkout yet. */
export default async function PricingPage() {
  await pricingOwner();
  return <main className={styles.page}>
    <nav><Link href="/operator/sales">Proces sprzedaży</Link><Link href="/operator/leads">Zgłoszenia kontaktowe</Link></nav>
    <header><p className={styles.eyebrow}>SKILLCHECK · CENY · WERSJA ROBOCZA</p><h1>Wewnętrzny kalkulator cen</h1>
      <p>Cena dla klienta jest liczona tym samym silnikiem wycen, którego użyje strona. Koszty i marże widzisz tylko Ty: zostają w tej przeglądarce i nie trafiają na serwer.</p>
      <p className={styles.notice} role="note">Prototyp do testów. Zmiany tutaj <strong>nie zmieniają</strong> cen na stronie dla klientów, w kalkulatorze publicznym ani przy zakupie.</p></header>
    <InternalCalculator />
  </main>;
}
