import Link from 'next/link';
import { companyAccess } from '../../../../../lib/company-access';
import { sc19PreviewPaymentConfig } from '../../../../../lib/sc19-payment-preview';
import Checkout from './checkout';
export default async function CheckoutPage({params}: {params: Promise<{companyId: string}>}) {
  const {companyId}=await params;
  const {company,user}=await companyAccess(companyId);
  // Same flag as billing/page.tsx and billing/actions.ts. With packages off the
  // link to this page is hidden, but the URL is still reachable, so without this
  // guard it would render a full priced order summary for a package that is not
  // being sold yet.
  const enabled=process.env.SC19_PACKAGES_ENABLED==='true';
  return <main className="container" style={{maxWidth:800,margin:'40px auto',padding:24}}>
    <Link href={`/dashboard/${companyId}`}>← Panel firmy</Link>
    <h1>Pakiet PRESELEKCJA</h1>
    {!enabled ? <p className="notice" role="status">Uruchomienie pakietów FREE i PRESELEKCJA jest przygotowywane. Zakup nie jest jeszcze dostępny.</p> : <>
      <p>Jednorazowy zakup analiz CV. Wyniki wymagają oceny rekrutera.</p>
      {company.owner_id===user.id ? <Checkout companyId={companyId} sandbox={!!sc19PreviewPaymentConfig(process.env)}/> :
        <p role="status">Zamówienie może złożyć właściciel firmy.</p>}
    </>}
  </main>;
}
