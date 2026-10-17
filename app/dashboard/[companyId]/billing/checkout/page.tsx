import Link from 'next/link';
import { companyAccess } from '../../../../../lib/company-access';
import Checkout from './checkout';
export default async function CheckoutPage({params}: {params: Promise<{companyId: string}>}) {
  const {companyId}=await params;
  const {company,user}=await companyAccess(companyId);
  return <main className="container" style={{maxWidth:800,margin:'40px auto',padding:24}}>
    <Link href={`/dashboard/${companyId}`}>← Panel firmy</Link>
    <h1>Pakiet PRESELEKCJA</h1>
    <p>Jednorazowy zakup analiz CV. Wyniki wymagają oceny rekrutera.</p>
    {company.owner_id===user.id ? <Checkout companyId={companyId}/> :
      <p role="status">Zamówienie może złożyć właściciel firmy.</p>}
  </main>;
}
