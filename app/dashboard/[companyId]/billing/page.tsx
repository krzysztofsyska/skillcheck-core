import Link from 'next/link';
import { companyAccess } from '../../../../lib/company-access';
import { activateSc19Free } from './actions';

const notices: Record<string,string> = {
  activated: 'Pakiet FREE został aktywowany.',
  invalid: 'Podaj prawidłowy polski NIP.',
  taken: 'Darmowa pula została już przypisana do tego NIP lub firmy.',
  failed: 'Nie udało się aktywować FREE. Skontaktuj się z obsługą SkillCheck.',
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

  const { data, error } = await client.rpc('sc19_get_balance', { target_company: companyId });
  if (error) throw new Error('Nie można odczytać limitu analiz firmy.');
  const balance = data?.[0] ?? null;
  const isOwner = user.id === company.owner_id;
  return <main className="workspace"><section>
    <Link href={`/dashboard/${companyId}`}>← Panel firmy</Link>
    <p className="eyebrow">SKILLCHECK / PAKIETY</p>
    <h1>Pakiety — {company.name}</h1>
    {status && Object.hasOwn(notices,status) && <p role="status" className="notice">{notices[status]}</p>}
    {balance ? <section aria-label="Twój pakiet">
      <h2>{balance.plan}</h2>
      <p><strong>{balance.available}</strong> analiz CV do wykorzystania</p>
      <p>Analiza wymaga zatwierdzonej anonimizacji CV i weryfikacji wyniku przez rekrutera. SkillCheck nie podejmuje decyzji o zatrudnieniu.</p>
    </section> : <>
      <h2>FREE — 5 analiz CV</h2>
      <p>Jednorazowa próba dla zweryfikowanej firmy. Sam poprawny NIP nie uprawnia do odbioru darmowej puli.</p>
      <p><Link href="/rozmowa">Zgłoś firmę do weryfikacji FREE →</Link></p>
      <p>Jeśli SkillCheck już potwierdził Twoją firmę, wpisz zatwierdzony NIP.</p>
      {isOwner ? <form action={activateSc19Free}>
        <input type="hidden" name="companyId" value={companyId} />
        <label>NIP firmy <input type="text" name="nip" inputMode="numeric" autoComplete="off" maxLength={20} required placeholder="10 cyfr" /></label>
        <button type="submit" className="button">Aktywuj FREE</button>
      </form> : <p className="notice">FREE może aktywować właściciel firmy.</p>}
    </>}
    <section>
      <h2>PRESELEKCJA — 60 analiz CV</h2>
      <p>Jednorazowy pakiet z rankingiem kandydatów i raportem. Zamówienie jest obsługiwane przez operatora — kredyty przyznajemy dopiero po potwierdzeniu wpłaty.</p>
      <p><Link className="button" href="/rozmowa">Zamów PRESELEKCJĘ</Link></p>
      <p className="notice">Brak płatności automatycznych. Oferta i warunki rozliczenia wymagają potwierdzenia przez obsługę.</p>
    </section>
  </section></main>;
}
