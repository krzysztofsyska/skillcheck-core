import Link from 'next/link';
import { companyAccess } from '../../../../../lib/company-access';
import { loadSc19PackageSizes } from '../../../../../lib/sc19-package-sizes';
import { preselekcjaOffer } from '../../../../../lib/preselekcja-offer';
import Checkout from './checkout';
export default async function CheckoutPage({params}: {params: Promise<{companyId: string}>}) {
  const {companyId}=await params;
  const {client,company,user}=await companyAccess(companyId);
  // The fallback summary must promise the quota the grant will actually use:
  // the live policy wins when the catalog is on, and an enabled but failing
  // catalog shows no number rather than the static one.
  const packagesEnabled=process.env.SC19_PACKAGES_ENABLED==='true';
  let fallbackCredits: number|null=preselekcjaOffer.analyses;
  if(packagesEnabled){
    try{fallbackCredits=(await loadSc19PackageSizes(client)).PRESELEKCJA;}catch{fallbackCredits=null;}
  }
  return <main className="container" style={{maxWidth:800,margin:'40px auto',padding:24}}>
    <Link href={`/dashboard/${companyId}`}>← Panel firmy</Link>
    <h1>Pakiet PRESELEKCJA</h1>
    <p>Jednorazowy zakup analiz CV. Wyniki wymagają oceny rekrutera.</p>
    {/* The rest of the product says packages are not launched while this flag is
        off (app/dashboard/[companyId]/billing/page.tsx); this screen must not
        contradict it, so it states the same thing instead of implying an
        automatic activation. */}
    {!packagesEnabled&&<p role="status" className="notice">Automatyczne przyznawanie pakietów nie jest jeszcze uruchomione. Zamówienie obsługuje operator: analizy dodajemy ręcznie po potwierdzeniu wpłaty.</p>}
    {company.owner_id===user.id ? <Checkout companyId={companyId} fallbackCredits={fallbackCredits}/> :
      <p role="status">Zamówienie może złożyć właściciel firmy.</p>}
  </main>;
}
