import 'server-only';
import { sc19SandboxPaymentGate } from '../../../lib/sc19-payment-preview';
import { sc19PackagesRefusal, type Sc19DiagnosticReason } from '../../../lib/sc19-p24-diagnostic';
import styles from '../sales/sales.module.css';
import { checkP24 } from './actions';

/** SC-P24-DIAG-001: names, in Polish, which condition stops the Przelewy24
 * Sandbox checkout on THIS deployment. Operator-only: this component is rendered
 * from `/operator/billing`, which is behind `platform_operator_status`.
 *
 * No value of any secret is shown. A refusal carries the variable's NAME and a
 * shape hint the gate produced (missing / empty / length:n / wrong:part+part),
 * and for the handful of variables that are public by construction — the Vercel
 * environment, the branch, the sandbox flag, the NEXT_PUBLIC_* addresses — the
 * value itself, because that is what names a typo. */
const reasons: Record<Sc19DiagnosticReason, { what: string; fix: string }> = {
  not_vercel: { what: 'to nie jest wdrożenie na Vercelu (zmienna VERCEL)',
    fix: 'płatności działają tylko na wdrożeniu Vercela — nic do ustawienia' },
  vercel_env: { what: 'środowisko wdrożenia (VERCEL_ENV) nie jest ani „production”, ani „preview”',
    fix: 'odpal stronę pod adresem skillcheck.pl, a nie pod adresem pojedynczego wdrożenia' },
  git_ref: { what: 'gałąź wdrożenia (VERCEL_GIT_COMMIT_REF) nie jest „main” (produkcja) ani „integration” (Preview)',
    fix: 'to wdrożenie powstało z innej gałęzi albo Vercel nie przekazuje zmiennych systemowych — włącz „Automatically expose System Environment Variables” w ustawieniach projektu i wdróż ponownie' },
  sandbox_flag: { what: 'P24_SANDBOX nie ma dokładnej wartości true',
    fix: 'ustaw P24_SANDBOX na true — małymi literami, bez spacji i cudzysłowów — i wdróż ponownie' },
  supabase_url: { what: 'NEXT_PUBLIC_SUPABASE_URL wskazuje inny projekt bazy, niż ten, na który to wdrożenie ma działać',
    fix: 'sprawdź adres projektu Supabase dla tego środowiska' },
  site_url: { what: 'NEXT_PUBLIC_SITE_URL to nie jest dokładnie https://skillcheck.pl',
    fix: 'ustaw NEXT_PUBLIC_SITE_URL na https://skillcheck.pl (ewentualnie z jednym ukośnikiem na końcu) i wdróż ponownie' },
  deployment_host: { what: 'to wdrożenie Preview nie ma zaufanego adresu *.vercel.app',
    fix: 'dotyczy tylko Preview — zgłoś to jako błąd wdrożenia' },
  request_origin: { what: 'strona została otwarta pod innym adresem niż ten, na który wolno przyjmować płatności',
    fix: 'otwórz skillcheck.pl (produkcja) albo adres gałęzi integration (Preview), nie adres pojedynczego wdrożenia' },
  p24_merchant_id: { what: 'P24_MERCHANT_ID nie jest liczbą większą od zera',
    fix: 'wpisz sam numer sprzedawcy z panelu Przelewy24 — bez spacji i bez innych znaków' },
  p24_pos_id: { what: 'P24_POS_ID nie jest liczbą większą od zera',
    fix: 'wpisz sam numer punktu sprzedaży (zwykle taki sam jak numer sprzedawcy)' },
  p24_crc: { what: 'P24_CRC jest pusty albo krótszy niż 8 znaków',
    fix: 'skopiuj klucz CRC z panelu Przelewy24 (sekcja „Moje dane” / konfiguracja) — uwaga na spację na końcu' },
  p24_api_key: { what: 'P24_API_KEY jest pusty albo krótszy niż 16 znaków',
    fix: 'skopiuj „klucz do raportów” (API key) z panelu Przelewy24 — uwaga na spację na końcu' },
  packages_flag: { what: 'SC19_PACKAGES_ENABLED nie ma dokładnej wartości true, więc serwer odmawia płatności jeszcze przed połączeniem z Przelewy24',
    fix: 'ustaw SC19_PACKAGES_ENABLED na true — małymi literami, bez spacji — i wdróż ponownie' },
  database_url: { what: 'adres bazy dla płatności (SC19_P24_CHECKOUT_DATABASE_URL na produkcji) nie zgadza się z oczekiwanym',
    fix: 'podpowiedź po dwukropku mówi, które części adresu są nie takie: username to nazwa roli, port musi być 6543, query oznacza doklejone parametry' },
};

/** What the read-only sprawdzenie dostępu w Przelewy24 answered. */
const probes: Record<string, string> = {
  provider_ok: 'Przelewy24 przyjęły numer punktu sprzedaży i klucz API (odpowiedź 200). Jeśli płatność nadal się nie otwiera, najbardziej prawdopodobny jest zły klucz CRC — on podpisuje żądania, ale nie służy do logowania.',
  provider_unauthorized: 'Przelewy24 odrzuciły logowanie (odpowiedź 401). Zły P24_POS_ID albo zły P24_API_KEY dla środowiska Sandbox — klucze z konta produkcyjnego tu nie zadziałają.',
  provider_http: 'Przelewy24 odpowiedziały czymś innym niż 200 i 401. To nie są nasze dane dostępowe — zapisz kod odpowiedzi i sprawdź status Sandboxa.',
  provider_unreachable: 'Serwer SkillChecka nie dostał żadnej odpowiedzi z sandbox.przelewy24.pl w 8 sekund. To znaczy, że problem jest po drodze (sieć albo blokada), a nie w kluczach.',
  unknown: 'Nie udało się wykonać sprawdzenia.',
};

export default function P24Diagnostic({ probe }: { probe?: string }) {
  // The same function the request path calls, with no request origin: this says
  // whether the deployment can take payments at all, not whether one click could.
  const gate = sc19SandboxPaymentGate(process.env);
  // The same two checks, in the same order, as the server action behind the
  // button: a panel that said "wszystkie warunki przechodzą" while the server
  // refuses would send the operator to Przelewy24 for a configuration fault.
  const refusal = gate.ok ? sc19PackagesRefusal(process.env) : gate.refusal;
  const known = refusal && reasons[refusal.reason];
  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Diagnostyka płatności Przelewy24 (Sandbox)</h2>
      {refusal ? (
        <>
          <p><strong>Płatności nie są włączone na tym wdrożeniu.</strong> Nie przechodzi ten warunek:</p>
          <p><strong>{refusal.reason}</strong> — {known ? known.what : 'nieznany warunek'}
            {' '}(stan zmiennej: <code>{refusal.shape}</code>)</p>
          {known ? <p>Co zrobić: {known.fix}</p> : null}
          <p>Po każdej zmianie zmiennej w Vercelu trzeba wdrożyć projekt ponownie — zmienne wchodzą
            w życie dopiero na nowym wdrożeniu.</p>
        </>
      ) : (
        <>
          <p><strong>Płatności są włączone na tym wdrożeniu</strong> — wszystkie warunki przechodzą.
            Jeśli kupujący dostaje błąd, to już nie konfiguracja, tylko sama rozmowa z Przelewy24.</p>
          <form action={checkP24} className={styles.form}>
            <button type="submit">Sprawdź połączenie z Przelewy24</button>
          </form>
          <p>Sprawdzenie jest bezpieczne: tylko pyta Przelewy24, czy przyjmują nasze dane dostępowe.
            Nie zakłada żadnej transakcji i nikogo nie obciąża.</p>
        </>
      )}
      {/* The probe result travels in the query string, so a reloaded or bookmarked
          address could otherwise print "klucze przyjęte" under a fresh refusal. */}
      {probe && !refusal ? <p><strong>Wynik sprawdzenia:</strong> {probes[probe] ?? probes.unknown}</p> : null}
      <p>Żadna wartość klucza, hasła ani adresu bazy nie jest tu pokazywana ani zapisywana.</p>
    </section>
  );
}
