import Link from 'next/link';
import { companyAccess } from '../../../../lib/company-access';
import { loadSc19PackageSizes, sc19AnalysisScope } from '../../../../lib/sc19-package-sizes';
import { activateSc19Free } from './actions';

const notices: Record<string,string> = {
  activated: 'Pakiet FREE został aktywowany.',
  invalid: 'Podaj prawidłowy polski NIP.',
  taken: 'Darmowa pula została już przypisana do tego NIP lub firmy.',
  failed: 'Nie udało się aktywować FREE. Skontaktuj się z obsługą SkillCheck.',
  // SC-FREE-AUTO-001: the registry did not confirm the company, did not answer,
  // or automatic activation is switched off. All of them mean the same thing for
  // the company, and none of them grants anything.
  // Deliberately NOT a notice string: the manual path is a form the company has
  // to reach, so this case renders a link to /rozmowa. Telling a company that
  // "the request went for checking" while the panel offers no way to reach us
  // was the whole complaint.
  manual: '',
  // SC-FREE-AUTO-001: the registry was asked about this firm a few minutes ago
  // and did not confirm it. Waiting is the fix, so the company is told to wait
  // rather than sent to the contact form.
  cooldown: 'Sprawdzaliśmy ten NIP w wykazie podatników VAT kilka minut temu i nie udało się go potwierdzić. '
    + 'Odczekaj około 5 minut i spróbuj ponownie. Wykaz Ministerstwa Finansów ma dzienny limit zapytań, '
    + 'który dzielimy ze wszystkimi firmami, dlatego nie pytamy o tę samą firmę kilka razy pod rząd.',
  verify: 'Przed aktywacją FREE wymagamy weryfikacji firmy. Wyślij zgłoszenie przez formularz kontaktowy.',
  forbidden: 'Darmową pulę może aktywować tylko właściciel firmy.',
};

export default async function CompanyBilling({ params, searchParams }: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { companyId } = await params;
  const { client, company, user } = await companyAccess(companyId);
  const enabled = process.env.SC19_PACKAGES_ENABLED === 'true';
  const { status } = await searchParams;
  if (!enabled) return <main className="workspace"><section>
    <Link href={`/dashboard/${companyId}`}>← Panel firmy</Link>
    <h1>Pakiety SkillCheck</h1>
    <p className="notice">Uruchomienie pakietów FREE i PRESELEKCJA jest przygotowywane. Analizy nie są jeszcze przydzielane automatycznie.</p>
  </section></main>;

  const sizes = await loadSc19PackageSizes(client);
  const { data, error } = await client.rpc('sc19_get_balance', { target_company: companyId });
  if (error) throw new Error('Nie można odczytać limitu analiz firmy.');
  const balance = data?.[0] ?? null;
  const isOwner = user.id === company.owner_id;
  return <main className="workspace"><section>
    <Link href={`/dashboard/${companyId}`}>← Panel firmy</Link>
    <p className="eyebrow">SKILLCHECK / PAKIETY</p>
    <h1>Pakiety — {company.name}</h1>
    {status === 'manual'
      ? <div role="status" className="notice">
          <p>Nie mogliśmy potwierdzić Twojej firmy automatycznie w wykazie podatników VAT, więc FREE nie włączyło się samo.
            Sprawdzimy zgłoszenie ręcznie — napisz do nas przez formularz, żebyśmy wiedzieli, kogo sprawdzić.</p>
          <p><Link href="/rozmowa">Zgłoś firmę do weryfikacji FREE →</Link></p>
        </div>
      : status && Object.hasOwn(notices,status) && notices[status]
        ? <p role="status" className="notice">{notices[status]}</p> : null}
    {balance ? <section aria-label="Twój pakiet">
      <h2>{balance.plan}</h2>
      <p><strong>{balance.available}</strong> analiz CV do wykorzystania</p>
      <p>Analiza wymaga zatwierdzonej anonimizacji CV i weryfikacji wyniku przez rekrutera. SkillCheck nie podejmuje decyzji o zatrudnieniu.</p>
    </section> : <>
      <h2>FREE — {sc19AnalysisScope(sizes.FREE)}</h2>
      <p>Jednorazowa próba dla jednej firmy. Podaj NIP — sprawdzimy go automatycznie w wykazie podatników VAT Ministerstwa Finansów.</p>
      <p>Jeśli wykaz potwierdzi, że firma istnieje i jest czynnym albo zwolnionym podatnikiem VAT, pakiet FREE włączy się od razu.
        Jeśli nie potwierdzi albo nie odpowie, sprawdzimy zgłoszenie ręcznie — <Link href="/rozmowa">napisz do nas przez formularz</Link>.</p>
      <p>Jedna firma może sprawdzić automatycznie jeden NIP. Jeśli pomylisz NIP, dalszą weryfikację zrobimy ręcznie.</p>
      {isOwner ? <form action={activateSc19Free}>
        <input type="hidden" name="companyId" value={companyId} />
        <label>NIP firmy <input type="text" name="nip" inputMode="numeric" autoComplete="off" maxLength={20} required placeholder="10 cyfr" /></label>
        <button type="submit" className="button">Aktywuj FREE</button>
      </form> : <p className="notice">FREE może aktywować właściciel firmy.</p>}
    </>}
    <section>
      <h2>PRESELEKCJA — {sc19AnalysisScope(sizes.PRESELEKCJA)}</h2>
      <p>Jednorazowy pakiet z rankingiem kandydatów i raportem. Zamówienie jest obsługiwane przez operatora — kredyty przyznajemy dopiero po potwierdzeniu wpłaty.</p>
      <p><Link className="button" href="/rozmowa">Zamów PRESELEKCJĘ</Link></p>
      <p className="notice">Brak płatności automatycznych. Oferta i warunki rozliczenia wymagają potwierdzenia przez obsługę.</p>
    </section>
  </section></main>;
}
