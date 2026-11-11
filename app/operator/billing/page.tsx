import 'server-only';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { salesOperator } from '../sales/access';
import { sc19OperatorNotices } from '../../../lib/sc19-operator';
import { approveTrial, grantPaid, publishOffer, releaseTrialNip, savePolicy, setAutoFree } from './actions';
import { formatGross } from '../../../lib/pricing/cv-pool';
import styles from '../sales/sales.module.css';
import OperatorCatalogOrders from './catalog-orders';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Pakiety firm | SkillCheck', robots: { index: false, follow: false } };

const dates = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' });

/** Plain Polish for the machine codes the automatic check records. An unknown
 * code is shown as it is rather than hidden. */
const autoOutcomes: Record<string, string> = {
  granted: 'FREE przyznany', refused: 'odmowa', unavailable: 'brak odpowiedzi wykazu',
};
/** Why publishing the offer is refused, in the operator's own words. The reason
 * comes from the database, which checks the same things the publishing function
 * checks, so the panel names the thing to fix instead of failing on the click. */
const offerRefusals: Record<string, string> = {
  catalog_missing: 'w cenniku nie ma opublikowanej wersji z pakietem PRESELEKCJA',
  catalog_not_sellable: 'cennik oznacza ten pakiet jako niedostępny do kupienia',
  catalog_mismatch: 'cena albo liczba CV w cenniku nie zgadza się z ofertą',
  policy_missing: 'nie ustawiono liczby analiz w pakiecie PRESELEKCJA (sekcja powyżej)',
  policy_mismatch: 'liczba analiz w pakiecie jest inna niż liczba sprzedawana w ofercie',
  revision_expired: 'ta wersja oferty straciła ważność — potrzebna jest nowa, przejrzana wersja',
};

const autoReasons: Record<string, string> = {
  AUTO_DISABLED: 'automat wyłączony lub bez klucza podpisu',
  ANOTHER_NIP_TRIED: 'to konto próbowało już innego NIP-u',
  NIP_TAKEN: 'ten NIP jest już zajęty',
  NIP_RELEASED: 'ten NIP został tej firmie odebrany przez operatora',
  COOLDOWN: 'zapytanie do wykazu było przed chwilą — firma czeka kilka minut',
  IN_FLIGHT: 'sprawdzenie rozpoczęte, bez odpowiedzi wykazu',
  STATUS_NOT_ACTIVE: 'w wykazie nie jest czynnym ani zwolnionym podatnikiem',
  NIP_NOT_FOUND: 'nie ma takiego NIP-u w wykazie',
  NIP_INVALID: 'NIP niepoprawny',
  NIP_NOT_ACTIVE: 'status w wykazie nie uprawnia do FREE',
  WHITELIST_ADDRESS_UNPARSEABLE: 'nie udało się odczytać adresu z wykazu',
  WHITELIST_UNAVAILABLE: 'wykaz niedostępny',
  WHITELIST_RATE_LIMITED: 'wykaz ograniczył zapytania',
  WHITELIST_TIMEOUT: 'wykaz nie odpowiedział na czas',
  WHITELIST_RESPONSE_INVALID: 'wykaz odpowiedział nieoczekiwanie',
  NO_SERVER_SECRET: 'brak klucza podpisu na serwerze',
};

/** SC-019 operator fulfillment: package policy, FREE verification and paid
 * PRESELEKCJA grants. Payment is confirmed outside the browser; this panel
 * only records the operator's decision through audited RPCs. */
export default async function OperatorBillingPage({ searchParams }: {
  searchParams: Promise<{ status?: string; q?: string; catalogStatus?: string }>;
}) {
  const client = await salesOperator();
  const { status, q, catalogStatus } = await searchParams;
  const search = (q ?? '').trim().slice(0, 200);
  const [policy, companies, consents, autoChecks, autoSettings, takenNips, releases, offer] = await Promise.all([
    client.rpc('sc19_operator_package_policy'),
    client.rpc('sc19_operator_companies', { search: search || null }),
    client.rpc('sc19_operator_marketing_consents', { search: search || null }),
    client.rpc('sc19_operator_auto_free_grants'),
    client.rpc('sc19_operator_auto_free_settings'),
    // The same search box as the companies list: the listing is capped at 200
    // rows and the release form is rendered from them, so without a search an
    // older occupied NIP would have no release form anywhere in the panel.
    client.rpc('sc19_operator_taken_trial_nips', { search: search || null }),
    client.rpc('sc19_operator_trial_nip_releases'),
    client.rpc('sc19_operator_published_offer'),
  ]);
  if (policy.error?.code === '42501' || companies.error?.code === '42501') notFound();
  if (policy.error || companies.error || !policy.data || !companies.data) throw new Error('Nie udało się odczytać pakietów.');
  // Consent and automatic-FREE reporting is additional information: a failure
  // there must not hide the package panel the operator needs to do their job.
  // But a failed READ must never read as "nothing to show": an empty fallback
  // turned an outage into "no consent" and "no company got FREE". Each of these
  // sections therefore distinguishes "could not be read" from "empty".
  const consentsFailed = Boolean(consents.error) || !consents.data;
  const consentByCompany = new Map((consents.data ?? []).map(row => [row.company_id, row]));
  const checksFailed = Boolean(autoChecks.error) || !autoChecks.data;
  const autoFree = autoChecks.data ?? [];
  const nipsFailed = Boolean(takenNips.error) || !takenNips.data;
  const taken = takenNips.data ?? [];
  const releasesFailed = Boolean(releases.error) || !releases.data;
  const released = releases.data ?? [];
  const auto = autoSettings.data?.[0] ?? null;
  // A failed read must not read as "no offer published": that would invite a
  // second publication of something already live.
  const offerFailed = Boolean(offer.error) || !offer.data?.length;
  const offerState = offer.data?.[0] ?? null;
  const credits = Object.fromEntries(policy.data.map(row => [row.plan, row.credits]));
  const notice = status && Object.hasOwn(sc19OperatorNotices, status) ? sc19OperatorNotices[status as keyof typeof sc19OperatorNotices] : null;

  return <main className={styles.page}>
    {process.env.SC19_CATALOG_ORDERS_ENABLED==='true'&&<OperatorCatalogOrders client={client} status={catalogStatus}/>}
    <nav><Link href="/operator/sales">Proces sprzedaży</Link><Link href="/operator/leads">Zgłoszenia</Link><Link href="/operator/ai-costs">Koszty AI i marża</Link><Link href="/">Strona główna</Link></nav>
    <header><p className={styles.eyebrow}>SKILLCHECK · PAKIETY</p><h1>Pakiety firm</h1>
      <p>Weryfikacja firm przed FREE i przydział PRESELEKCJI po potwierdzonej wpłacie. Każda operacja jest sprawdzana w bazie i zapisywana w dzienniku analiz.</p></header>
    {notice && <p role="status" className={styles.empty}>{notice}</p>}

    <section className={styles.card} aria-labelledby="policy">
      <h2 id="policy">Liczba analiz w pakietach</h2>
      {!policy.data.length && <p>Pakiety nie są jeszcze skonfigurowane. Bez tego FREE ani PRESELEKCJA nie przydzielą analiz.</p>}
      <ul>{policy.data.map(row => <li key={row.plan}><strong>{row.plan}</strong>: {row.credits} analiz CV · zmieniono {dates.format(new Date(row.updated_at))}</li>)}</ul>
      <form action={savePolicy} className={styles.form}>
        <label>Pakiet <select name="plan" defaultValue="FREE"><option value="FREE">FREE</option><option value="PRESELEKCJA">PRESELEKCJA</option></select></label>
        <label>Liczba analiz CV <input name="credits" type="number" min={1} max={100000} required /></label>
        <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Zmiana dotyczy kolejnych aktywacji i przydziałów, nie istniejących sald.</label>
        <button type="submit">Zapisz</button>
      </form>
    </section>

    {/* SC-019 offer publication. Without a published offer a verified company
        sees nothing to buy on the checkout page. What is published — price,
        number of CV analyses and the whole terms text — is fixed in the database
        and reviewed in code; the operator decides only WHETHER to publish. */}
    <section className={styles.card} aria-labelledby="offer">
      <h2 id="offer">Oferta na stronie zakupu</h2>
      {offerFailed ? <p className={styles.empty}>Nie udało się odczytać stanu oferty. Odśwież stronę i nie publikuj „na wszelki wypadek”.</p>
        : offerState!.published_offer_id ? <>
          <p>Opublikowana: <strong>PRESELEKCJA — {formatGross(offerState!.published_amount_minor!)} brutto
            za {offerState!.published_credits} analiz CV</strong></p>
          <p className={styles.hint}>Wersja regulaminu: {offerState!.published_terms_revision}
            {' · '}opublikowano {offerState!.published_at ? dates.format(new Date(offerState!.published_at)) : 'nieznana data'}
            {' · '}ważna do {dates.format(new Date(Number(offerState!.published_valid_until_ms)))}
            {typeof offerState!.expires_in_days === 'number' ? ` (${offerState!.expires_in_days} dni)` : ''}</p>
          {offerState!.expiring_soon && <p role="alert" className={styles.empty}>
            <strong>Oferta wygasa w ciągu 30 dni.</strong> Po tej dacie klient przestanie widzieć pakiet
            do kupienia i nie będzie o tym żadnego komunikatu. Zgłoś zespołowi przygotowanie nowej,
            przejrzanej wersji oferty, zanim ta straci ważność.</p>}
        </> : <p>Żadna oferta nie jest opublikowana. Zweryfikowana firma nie widzi dziś nic do kupienia
          na stronie zakupu.</p>}

      {!offerFailed && <>
        <p className={styles.hint}>Publikacja wystawi: PRESELEKCJA — {formatGross(offerState!.revision_amount_minor)} brutto
          za {offerState!.revision_credits} analiz CV, regulamin {offerState!.revision_terms_revision},
          ważna do {dates.format(new Date(Number(offerState!.revision_valid_until_ms)))}.
          Cena, liczba analiz i treść regulaminu są ustalone w kodzie i nie da się ich tu zmienić.
          Publikacja nie włącza płatności online — sprzedaż idzie przelewem, a pakiet przydzielasz niżej po wpłacie.</p>
        {offerState!.publishable
          ? <form action={publishOffer} className={styles.form}>
              <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Rozumiem, że po publikacji zweryfikowana firma zobaczy ten pakiet, tę cenę i ten regulamin.</label>
              <button type="submit">Opublikuj ofertę</button>
            </form>
          : <p role="alert" className={styles.empty}>Publikacja jest teraz niemożliwa:{' '}
            {offerRefusals[offerState!.refusal ?? ''] ?? offerState!.refusal}. Dopóki to trwa, nic nie zostanie opublikowane.</p>}
      </>}
    </section>

    {/* SC-FREE-AUTO-001: the switch and the record of what it did. Turning it
        on changes who may receive FREE without an operator, so it is an
        operator action with an explicit confirmation. */}
    <section className={styles.card} aria-labelledby="auto-free">
      <h2 id="auto-free">Automatyczne FREE z wykazu VAT</h2>
      {auto ? <p>Automat jest <strong>{auto.auto_free_enabled ? 'włączony' : 'wyłączony'}</strong>
        {auto.secret_configured ? '' : ' · brak klucza podpisu na serwerze, więc i tak nic nie przyzna'}
        {auto.updated_at ? ` · zmieniono ${dates.format(new Date(auto.updated_at))}` : ''}</p>
        : <p>Nie udało się odczytać ustawień automatu.</p>}
      <p className={styles.hint}>Przy włączonym automacie firma dostaje FREE tylko wtedy, gdy wykaz podatników VAT
        potwierdzi, że NIP istnieje i jest czynnym podatnikiem. Każda inna odpowiedź, brak odpowiedzi lub błąd
        oznacza brak przyznania i ręczne sprawdzenie poniżej.</p>
      {/* The select shows the CURRENT state, so it reads as the state and not as
          a "toggle" whose meaning is the opposite of what it says. Choose the
          state you want and save; saving the state it already has changes nothing. */}
      <form action={setAutoFree} className={styles.form}>
        <label>Automat ma być <select name="enabled" defaultValue={auto?.auto_free_enabled ? 'true' : 'false'}>
          <option value="true">włączony</option><option value="false">wyłączony</option></select></label>
        <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Rozumiem, że przy włączonym automacie FREE przyznaje się bez udziału operatora.</label>
        <button type="submit">Zapisz</button>
      </form>
    </section>

    {/* SC-FREE-AUTO-001: every automatic check, not only the grants. A refusal
        or an outage is exactly what says which company is waiting and why. */}
    <section aria-labelledby="auto-free-list">
      <h2 id="auto-free-list">Automatyczne sprawdzenia w wykazie VAT</h2>
      <p className={styles.hint}>Do 200 ostatnich sprawdzeń, od najnowszego. Źródłem decyzji był wykaz podatników VAT, nie operator.
        „Zużyte analizy” to zużycie z całego konta firmy (również z pakietów płatnych), nie tylko z FREE.</p>
      {checksFailed ? <p className={styles.empty}>Nie udało się odczytać listy sprawdzeń. Odśwież stronę.</p>
        : !autoFree.length ? <p className={styles.empty}>Nie było jeszcze żadnego automatycznego sprawdzenia.</p>
        : <ol className={styles.list}>{autoFree.map(row => <li key={`${row.company_id}-${row.checked_at}-${row.outcome}`} className={styles.card}>
          <div className={styles.cardTitle}><h3>{row.company_name}</h3>
            <span className={styles.badge}>{autoOutcomes[row.outcome] ?? row.outcome}</span></div>
          <p className={styles.hint}>NIP {row.nip} · {dates.format(new Date(row.checked_at))}
            {row.mf_status ? ` · status w wykazie: ${row.mf_status}` : ''}
            {row.error_code ? ` · powód: ${autoReasons[row.error_code] ?? row.error_code}` : ''}</p>
          {row.outcome === 'granted' && <p className={styles.hint}>
            {row.granted_credits ?? 0} analiz przyznanych · zużyte analizy na koncie firmy (łącznie): {row.used_credits ?? 0}</p>}
        </li>)}</ol>}
    </section>

    {/* Blocker remedy: a NIP is public, so one account can occupy another
        company's single FREE once. Releasing the NIP lets the real company
        activate FREE afterwards. It does NOT take analyses back — that is a
        billing action and the owner's decision. */}
    <section aria-labelledby="taken-nips">
      <h2 id="taken-nips">Zajęte NIP-y (jedno FREE na NIP)</h2>
      <p className={styles.hint}>Do 200 NIP-ów, od najnowszego. Jeśli NIP zajęła firma, która go nie reprezentuje, zwolnij go —
        prawdziwa firma będzie mogła wtedy aktywować FREE. Zwolnienie nie odbiera już przyznanych analiz.</p>
      {nipsFailed ? <p className={styles.empty}>Nie udało się odczytać listy zajętych NIP-ów. Odśwież stronę.</p>
        : !taken.length ? <p className={styles.empty}>Żaden NIP nie jest jeszcze zajęty.</p>
        : <ol className={styles.list}>{taken.map(row => <li key={row.nip} className={styles.card}>
          <div className={styles.cardTitle}><h3>NIP {row.nip}</h3>
            <span className={styles.badge}>{row.free_claimed ? 'FREE wykorzystany' : 'FREE czeka na aktywację'}</span></div>
          <p className={styles.hint}>{row.company_name} · ID {row.company_id}
            {row.approved_at ? ` · zajęty ${dates.format(new Date(row.approved_at))}` : ''} · źródło: {row.source}</p>
          <details><summary>Zwolnij ten NIP</summary>
            <form action={releaseTrialNip} className={styles.form}>
              <input type="hidden" name="nip" value={row.nip} />
              {/* The company this line is about. Sent with the form so the
                  database can refuse the release if the NIP has moved to
                  another company since this page was rendered. */}
              <input type="hidden" name="companyId" value={row.company_id} />
              <input type="hidden" name="q" value={search} />
              <label>Powód zwolnienia (co sprawdzono i kiedy) <input name="reason" minLength={8} maxLength={300} required /></label>
              <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Sprawdzono, że ta firma nie reprezentuje tego NIP-u.</label>
              <button type="submit">Zwolnij NIP</button>
            </form></details>
        </li>)}</ol>}
      <h3>Zwolnione NIP-y</h3>
      {releasesFailed ? <p className={styles.empty}>Nie udało się odczytać historii zwolnień.</p>
        : !released.length ? <p className={styles.empty}>Nic jeszcze nie zwolniono.</p>
        : <ul>{released.map(row => <li key={`${row.nip}-${row.released_at}`}>NIP {row.nip} · {row.company_name ?? row.released_company_id}
          {' · '}{dates.format(new Date(row.released_at))} · {row.reason}</li>)}</ul>}
    </section>

    <section aria-labelledby="companies">
      <h2 id="companies">Firmy</h2>
      <form method="get" className={styles.filters}>
        <label>Nazwa firmy lub ID <input name="q" defaultValue={search} maxLength={200} /></label>
        <button type="submit">Szukaj</button>
      </form>
      <p className={styles.hint}>Do 200 firm, od najnowszej.</p>
      {!companies.data.length ? <p className={styles.empty}>Brak firm.</p> : <ol className={styles.list}>
        {companies.data.map(company => <li key={company.company_id} className={styles.card}>
          <div className={styles.cardTitle}><h2>{company.company_name}</h2>
            <span className={styles.badge}>{company.plan ? `${company.plan} · ${company.available} analiz` : 'Brak pakietu'}</span></div>
          <p className={styles.hint}>ID {company.company_id} · utworzona {dates.format(new Date(company.created_at))}</p>
          {/* SC-CONSENT-001: consent state per company. The wording is not
              repeated here; the operator needs the state and the time. */}
          <p className={styles.hint}>Zgoda na kontakt handlowy: {(() => {
            // A failed read is NOT "no consent": saying "nie wyrażona" during an
            // outage would show the operator false consent data.
            if (consentsFailed) return 'nie udało się odczytać';
            const consent = consentByCompany.get(company.company_id);
            if (!consent) return 'nie wyrażona';
            return `${consent.event === 'granted' ? 'aktywna' : 'wycofana'} · ${consent.consent_version} · ${dates.format(new Date(consent.occurred_at))}`;
          })()}</p>
          {company.approved_nip
            ? <p>Zweryfikowana: NIP {company.approved_nip}{company.approved_at ? ` · ${dates.format(new Date(company.approved_at))}` : ''}{company.free_claimed ? ' · FREE aktywowany' : ' · FREE czeka na aktywację przez właściciela'}</p>
            : <details><summary>Zweryfikuj firmę przed FREE</summary>
              <form action={approveTrial} className={styles.form}>
                <input type="hidden" name="companyId" value={company.company_id} />
                <input type="hidden" name="q" value={search} />
                <label>NIP firmy <input name="nip" inputMode="numeric" maxLength={13} required /></label>
                <label>Dowód weryfikacji (np. numer KRS/CEIDG i data sprawdzenia) <input name="proof" minLength={8} maxLength={100} required /></label>
                <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Zweryfikowano, że zgłaszający reprezentuje firmę o tym NIP.</label>
                <button type="submit">Zatwierdź weryfikację</button>
              </form></details>}
          <details><summary>Przydziel PRESELEKCJĘ po wpłacie{credits.PRESELEKCJA ? ` (${credits.PRESELEKCJA} analiz)` : ''}</summary>
            <form action={grantPaid} className={styles.form}>
              <input type="hidden" name="companyId" value={company.company_id} />
              <input type="hidden" name="q" value={search} />
              <label>Numer rozliczenia (np. numer faktury lub transakcji) <input name="settlement" minLength={8} maxLength={160} required /></label>
              <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Wpłata jest zaksięgowana i potwierdzona poza przeglądarką klienta.</label>
              <button type="submit">Przydziel pakiet</button>
            </form></details>
        </li>)}
      </ol>}
    </section>
  </main>;
}
