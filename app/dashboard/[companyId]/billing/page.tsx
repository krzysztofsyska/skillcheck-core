import Link from 'next/link';
import { companyAccess } from '../../../../lib/company-access';
import { loadSc19PackageSizes, sc19AnalysisScope } from '../../../../lib/sc19-package-sizes';
import { activateSc19Free } from './actions';
import { loadCompanyCatalog } from '../../../../lib/sc19-company-catalog';
import { formatGross } from '../../../../lib/pricing/cv-pool';

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
  searchParams: Promise<{ status?: string; recruitmentId?: string | string[] }>;
}) {
  const { companyId } = await params;
  const { client, company, user } = await companyAccess(companyId);
  const enabled = process.env.SC19_PACKAGES_ENABLED === 'true';
  const { status, recruitmentId } = await searchParams;
  // Only a UUID can carry the originating recruitment through the billing
  // catalogue. Never trust caller-provided paths or cross-company redirects.
  const sourceId = typeof recruitmentId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recruitmentId)
    ? recruitmentId : null;
  const backHref = sourceId
    ? `/dashboard/${companyId}/recruitments/${sourceId}`
    : `/dashboard/${companyId}`;
  const checkoutHref = `/dashboard/${companyId}/billing/checkout` +
    (sourceId ? `?recruitmentId=${encodeURIComponent(sourceId)}` : '');
  const backLabel = sourceId ? 'Wróć do rekrutacji' : 'Panel firmy';
  if (!enabled) return <main className="workspace"><section>
    <Link href={backHref}>← {backLabel}</Link>
    <h1>Pakiety SkillCheck</h1>
    <p className="notice">Uruchomienie pakietów FREE i PRESELEKCJA jest przygotowywane. Analizy nie są jeszcze przydzielane automatycznie.</p>
  </section></main>;

  const sizes = await loadSc19PackageSizes(client);
  const { data, error } = await client.rpc('sc19_get_balance', { target_company: companyId });
  if (error) throw new Error('Nie można odczytać limitu analiz firmy.');
  const balance = data?.[0] ?? null;
  const isOwner = user.id === company.owner_id;
  const catalogEnabled = process.env.SC19_CATALOG_ENABLED === 'true';
  const catalog = catalogEnabled ? await loadCompanyCatalog(client) : null;
  return <main className="workspace"><section>
    <Link href={backHref}>← {backLabel}</Link>
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
    {catalogEnabled && <section aria-label="Katalog pakietów">
      <h2>Katalog pakietów</h2>
      <p>Ceny katalogowe brutto za podstawową pulę CV. Ten podgląd nie zmienia Twojego pakietu ani pozostałych analiz.
        Dostępność zamówienia, jego cenę i warunki potwierdzisz w kasie przed zakupem.</p>
      {catalog ? <>
        <table><caption>Pakiety z opublikowanego katalogu</caption>
          <thead><tr><th scope="col">Pakiet</th><th scope="col">Pula CV</th><th scope="col">Cena brutto</th><th scope="col">Dostępność</th></tr></thead>
          <tbody>{catalog.packages.map(pkg => <tr key={pkg.code}>
            <th scope="row">{pkg.name}</th><td>{pkg.cvIncluded}</td><td>{formatGross(pkg.grossMinor)}</td><td>{pkg.availability}</td>
          </tr>)}</tbody>
        </table>
        <h3>Dodatki</h3>
        <p>Zakup dodatków nie jest jeszcze dostępny. Pozycje poniżej nie są doliczane do zamówienia.</p>
        {catalog.addons.length > 0 ? <ul>{catalog.addons.map(addon => <li key={addon.code}>
          {addon.name}: {formatGross(addon.grossMinor)} brutto / {addon.unit} — niedostępny do zakupu
        </li>)}</ul> : <p>Brak dodatków dostępnych do prezentacji.</p>}
      </> : <p role="status">Nie można teraz odczytać katalogu. Spróbuj ponownie później.</p>}
    </section>}
    <section>
      <h2>PRESELEKCJA — {sc19AnalysisScope(sizes.PRESELEKCJA)}</h2>
      <p>Jednorazowy pakiet z rankingiem kandydatów i raportem. Analizy CV przyznajemy po potwierdzeniu płatności.</p>
      <p><Link className="button" href="/rozmowa">Zamów przez obsługę SkillCheck</Link></p>
      {isOwner && <p><Link href={checkoutHref}>Przejdź do zakupu online (Przelewy24) →</Link></p>}
      <p className="notice">Aktualną ofertę, warunki i dostępność płatności online sprawdzisz na ekranie zakupu. Możesz też zamówić pakiet przez obsługę SkillCheck.</p>
    </section>
  </section></main>;
}
