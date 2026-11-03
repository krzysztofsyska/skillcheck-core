import Link from 'next/link';
import { companyAccess } from '../../../../../lib/company-access';
import { loadSc19PackageSizes } from '../../../../../lib/sc19-package-sizes';
import Checkout from './checkout';
export default async function CheckoutPage({params}: {params: Promise<{companyId: string}>}) {
  const {companyId}=await params;
  const {client,company,user}=await companyAccess(companyId);
  const packagesEnabled=process.env.SC19_PACKAGES_ENABLED==='true';
  // The promised quota is always verified against the policy the grant will
  // use. The flag decides how a package is activated, never whether the number
  // shown to a paying customer is real: public.sc19_package_sizes() is readable
  // either way, and an unreadable policy must block the purchase, not fall back
  // to the marketing figure.
  let fallbackCredits: number|null;
  try{fallbackCredits=(await loadSc19PackageSizes(client)).PRESELEKCJA;}catch{fallbackCredits=null;}
  return <main className="container" style={{maxWidth:800,margin:'40px auto',padding:24}}>
    <Link href={`/dashboard/${companyId}`}>← Panel firmy</Link>
    <h1>Pakiet PRESELEKCJA</h1>
    <p>Jednorazowy zakup analiz CV. Wyniki wymagają oceny rekrutera.</p>
    {/* The rest of the product says packages are not launched while this flag is
        off (app/dashboard/[companyId]/billing/page.tsx); this screen must not
        contradict it, so it states the same thing instead of implying an
        automatic activation. */}
    {!packagesEnabled&&<p role="status" className="notice">Automatyczne przyznawanie pakietów nie jest jeszcze uruchomione. Zamówienie obsługuje operator: analizy dodajemy ręcznie po potwierdzeniu wpłaty.</p>}
    {company.owner_id===user.id ? <Checkout companyId={companyId} fallbackCredits={fallbackCredits} packagesEnabled={packagesEnabled}/> :
      <p role="status">Zamówienie może złożyć właściciel firmy.</p>}
  </main>;
}
