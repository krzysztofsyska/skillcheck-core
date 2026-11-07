import Link from 'next/link';
import { companyAccess } from '../../../../../lib/company-access';
import { sc19PreviewPaymentConfig } from '../../../../../lib/sc19-payment-preview.ts';
import Checkout from './checkout';
export default async function CheckoutPage({params,searchParams}: {params: Promise<{companyId: string}>;searchParams:Promise<{p24?:string|string[];recruitmentId?:string|string[]}>}) {
  const {companyId}=await params;
  const {company,user}=await companyAccess(companyId);
  // Same flag as billing/page.tsx and billing/actions.ts. With packages off the
  // link to this page is hidden, but the URL is still reachable, so without this
  // guard it would render a full priced order summary for a package that is not
  // being sold yet.
  const enabled=process.env.SC19_PACKAGES_ENABLED==='true';
  const sandbox = !!sc19PreviewPaymentConfig(process.env);
  const query=await searchParams;
  const returnId = query?.p24;
  // Never follow a caller-provided URL. Reconstruct an in-tenant link from a UUID only;
  // the recruitment page enforces the user's company membership on arrival.
  const recruitmentId=query?.recruitmentId;
  const backToRecruitment=typeof recruitmentId==='string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recruitmentId);
  const returning = sandbox && company.owner_id === user.id && typeof returnId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(returnId);
  return <main className="container" style={{maxWidth:800,margin:'40px auto',padding:24}}>
    <Link href={backToRecruitment ? `/dashboard/${companyId}/recruitments/${recruitmentId}` : `/dashboard/${companyId}`}>
      ← {backToRecruitment ? 'Wróć do rekrutacji' : 'Panel firmy'}
    </Link>
    <h1>Pakiet PRESELEKCJA</h1>
    {!enabled && returning ? <Checkout companyId={companyId} recruitmentId={backToRecruitment ? recruitmentId : undefined} sandbox statusOnly/> : !enabled ? <p className="notice" role="status">Uruchomienie pakietów FREE i PRESELEKCJA jest przygotowywane. Zakup nie jest jeszcze dostępny.</p> : <>
      <p>Jednorazowy zakup analiz CV. Wyniki wymagają oceny rekrutera.</p>
      {company.owner_id===user.id ? <Checkout companyId={companyId} recruitmentId={backToRecruitment ? recruitmentId : undefined} sandbox={sandbox}/> :
        <p role="status">Zamówienie może złożyć właściciel firmy.</p>}
    </>}
  </main>;
}
