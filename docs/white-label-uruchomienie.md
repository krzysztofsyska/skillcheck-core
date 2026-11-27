# White-label SkillCheck — uruchomienie dla nowego klienta

Dokument dla osoby technicznej po stronie klienta (administrator domeny, IT) oraz dla operatora
SkillCheck. Opisuje stan kodu z gałęzi `integration` (ROADMAP R8, SC-020). Wszystkie nazwy i wartości
poniżej pochodzą z kodu (`lib/tenant-domains.ts`, `lib/tenant-domain-verifier.ts`,
`lib/tenant-domain-reverify.ts`, `lib/brand-config.ts`, migracje
`20261109190000_sc020_brand_configuration.sql` i `20261109200000_sc020_customer_domains.sql`).
Wycena white-label to decyzja właściciela i nie jest tu opisana.

## 1. Co to jest i co jest włączone

Klient (firma) może mieć panel rekrutera w swojej marce (nazwa, logo, kolory, favicon) i pod własnym
adresem, np. `kariera.twojafirma.pl`. Nagłówek i wstęp panelu kandydata są w kodzie tylko **podglądem
konfiguracji** na stronie marki; opublikowana marka nie zmienia tego, co widzi kandydat (patrz 6).
Dwie niezależne części:

- marka: strona „Wygląd panelu” (`/dashboard/<firma>/marka`),
- domena: strona „Domeny” (`/dashboard/<firma>/domeny`),
- wspólna historia zmian obu: `/dashboard/<firma>/zmiany-marki`.

Obie strony zarządzają wyłącznie właściciel konta firmy. Pozostali członkowie firmy widzą co najwyżej
opublikowaną markę.

**Przełącznik (flaga).** Jedna zmienna `WHITE_LABEL_ENABLED` steruje marką i domenami:

- `true` — włączone w każdym środowisku, `false` — wyłączone,
- bez ustawienia: włączone tylko na Vercel Preview i lokalnie w trybie deweloperskim; **na produkcji
  wyłączone** (strony „Wygląd panelu” i „Domeny” zwracają wtedy 404).

Włączenie na produkcji to zmiana ustawień produkcji Vercel, czyli decyzja właściciela SkillCheck.
Nie robi tego agent ani klient.

## 2. Co klient ustawia w swojej domenie (DNS)

### 2.1. Rekord potwierdzający własność domeny (TXT) — sprawdzany przez kod

Po dodaniu domeny w panelu („Domeny” → „Dodaj domenę”) strona pokazuje rekord do wpisania u
dostawcy DNS klienta. Format jest stały:

| Pole | Wartość |
|---|---|
| Typ | `TXT` |
| Nazwa | `_skillcheck-challenge.<twoja-domena>` |
| Wartość | `skillcheck-domain-verification=<token>` |

`<twoja-domena>` to dokładnie ta nazwa, którą wpisano w panelu (np. dla `kariera.twojafirma.pl`
nazwa rekordu to `_skillcheck-challenge.kariera.twojafirma.pl`). `<token>` to 64 znaki szesnastkowe
(0–9, a–f) wygenerowane losowo dla tego zgłoszenia; **pełną wartość rekordu kopiuje się ze strony
„Domeny”**, nie z tego dokumentu. Token jest widoczny tylko dla właściciela firmy.

Uwagi do wpisu:

- Wartość musi być identyczna z podaną (kod porównuje sklejoną treść rekordu 1:1). Dopuszczalne jest
  więcej rekordów TXT pod tą samą nazwą; liczy się, że jeden z nich ma dokładnie tę wartość.
- Wielu dostawców DNS dopisuje domenę do nazwy sam. Jeśli panel dostawcy tego wymaga, w polu nazwy
  wpisuje się samo `_skillcheck-challenge.kariera` (dla domeny głównej `twojafirma.pl`).
- Rekord zostaw na stałe (patrz 3.3). Usunięcie rekordu po weryfikacji nie wyłączy domeny od razu,
  ale domena przestanie być ponawiana i po terminie wróci do stanu „czeka na weryfikację”.
- Każde nowe zgłoszenie tej samej domeny (np. po odwołaniu) dostaje nowy token i trzeba wpisać nowy
  rekord.

### 2.2. Skierowanie domeny na platformę — NIE jest opisane w kodzie

Aby adres `kariera.twojafirma.pl` w ogóle otwierał SkillCheck, domena musi wskazywać na platformę
hostingową (rekord CNAME albo A/AAAA). **Kod nie zawiera ani nie sprawdza żadnej takiej wartości**,
więc ten dokument jej nie podaje, żeby jej nie zmyślać. Strona „Domeny” mówi tylko, że „tę część
konfigurujemy razem z Tobą”. Adres docelowy przekazuje klientowi operator SkillCheck, gdy domena
zostanie dodana w Vercel (na produkcji robi to właściciel lub zatwierdzony pipeline, patrz punkt 5). Kod weryfikuje wyłącznie rekord TXT z 2.1 oraz certyfikat TLS (punkt 3).

### 2.3. Poczta

Wiadomości do kandydatów z domeny klienta (SPF, DKIM, adres nadawcy) **nie są zaimplementowane**.
Klient nie ustawia w DNS niczego związanego z pocztą na potrzeby SkillCheck (patrz punkt 6).

## 3. Jak działa weryfikacja

### 3.1. Kroki

1. Właściciel dodaje domenę. Status: „czeka na weryfikację” (`pending`).
2. Właściciel wpisuje rekord TXT u dostawcy DNS i klika „Sprawdź”.
3. Serwer odczytuje rekord `_skillcheck-challenge.<domena>`. Znaleziony i zgodny — status
   „zweryfikowana” (`verified`). Brak rekordu — komunikat „Nie znaleźliśmy rekordu DNS”.
4. Przy statusie „zweryfikowana” serwer od razu sprawdza certyfikat TLS: łączy się z publicznym
   adresem domeny na porcie 443 i wymaga poprawnego, zaufanego certyfikatu dla tej nazwy. Adresy
   prywatne i specjalne są pomijane.
5. Gdy DNS i certyfikat są w porządku, pojawia się przycisk „Włącz”. Po jego kliknięciu domena
   jest „włączona” (`active`) i panel firmy działa pod tym adresem. „Wyłącz” cofa do „zweryfikowana”,
   „Odwołaj” kończy zgłoszenie.

Kolejność jest wymuszona w bazie danych: nie da się włączyć domeny bez potwierdzonego DNS i
certyfikatu, a właściciel nie może sam oznaczyć domeny jako zweryfikowanej.

### 3.2. Jak długo to trwa

- Samo sprawdzenie trwa sekundy (limit czasu zapytania DNS i TLS: po 5 s).
- Propagacja DNS zależy od dostawcy klienta — strona mówi o „kilku godzinach”. Jeśli „Sprawdź”
  zwróci brak rekordu, wystarczy ponowić po jakimś czasie. Błąd sieci przy sprawdzaniu DNS
  („Nie udało się teraz sprawdzić DNS”) nie zmienia statusu domeny.
- **Zgłoszenie wygasa**, jeśli w ustawieniu `pending_days` (domyślnie **7 dni**) rekord nie zostanie
  potwierdzony. Wtedy trzeba dodać domenę od nowa (nowy token).
- Certyfikat TLS pojawia się dopiero, gdy platforma hostingowa ma tę domenę dodaną (punkt 5). Do
  tego czasu wynik to „Rekord DNS jest w porządku, ale certyfikat … nie jest jeszcze gotowy”.

### 3.3. Ponowna weryfikacja co 30 dni

Własna domena działa tylko, gdy ostatnia udana weryfikacja DNS jest młodsza niż `reverify_days`
(domyślnie **30 dni**). Strona „Domeny” ostrzega na 7 dni przed terminem. Po terminie panel wraca
na adres platformy, a po nieudanym sprawdzeniu domena wraca do „czeka na weryfikację” z nowym
terminem na potwierdzenie. Klient odnawia przez kliknięcie „Sprawdź” (rekord TXT musi nadal
istnieć). Wartości domyślne to ustawienia bazy (jeden wiersz `tenant_domains.settings`), nie stałe
w kodzie; zmiana na produkcji to sprawa właściciela lub zatwierdzonego pipeline (punkt 5).

Zadanie automatyczne, które samo ponawia DNS, jest napisane (`lib/tenant-domain-reverify.ts`), ale
**nie jest uruchomione** (patrz punkt 5). Bez niego odnawia klient ręcznie.

### 3.4. Co klient dostaje po stronie zasad

- Limit: domyślnie 5 otwartych domen na firmę (`max_domains_per_company`).
- Nazwy zastrzeżone są odrzucane: m.in. `skillcheck.pl`, `vercel.app`, `supabase.co`, nazwy
  techniczne (`localhost`, `test`, `example.com`, …) oraz — dla subdomen platformy — etykiety jak
  `www`, `app`, `admin`, `login`, `mail`, `api`.
- Wpisuje się samą nazwę hosta: bez `https://`, ścieżki, portu, adresu IP. Wielkość liter i kropka
  na końcu nie mają znaczenia; nazwy z polskimi znakami są zamieniane na zapis punycode.
- Jedna domena może być potwierdzona tylko dla jednej firmy. Jeśli ktoś inny już ją potwierdził,
  wynik to „potwierdzona przez inne konto” i trzeba skontaktować się z obsługą.
- Subdomeny platformy (`<nazwa>.<baza>`) są **domyślnie wyłączone** (`subdomain_base` nie ma
  wartości). Wymagają ustawienia w bazie (punkt 5). Nie wymagają rekordu TXT od klienta.

### 3.5. Zachowanie panelu pod domeną klienta

- Na domenie firmy X dostępny jest tylko panel firmy X. Panel operatora zwraca 404, zakładanie
  nowej firmy przekierowuje do panelu firmy, panel innej firmy zwraca 404.
- Ciasteczka sesji są przypisane tylko do tego hosta, więc użytkownik loguje się osobno na domenie
  klienta i osobno na platformie.
- Jeśli baza jest chwilowo niedostępna, domena klienta odpowiada błędem 503 (a nie zachowaniem
  platformy), żeby awaria nie zdejmowała ograniczeń tras.
- Hosty samej platformy są rozpoznawane z konfiguracji (`NEXT_PUBLIC_SITE_URL`, zmienne `VERCEL_*`).
  Każdy alias platformy musi tam być wpisany przed włączeniem white-label; na produkcji
  zmienne ustawia właściciel (lub zatwierdzony pipeline).

## 4. Co ustawia właściciel firmy w panelu (marka)

Strona „Wygląd panelu” (`/dashboard/<firma>/marka`), tylko właściciel konta:

1. **Pliki.** Logo: PNG, SVG lub WebP, do 512 KB. Favicon: PNG, SVG, ICO lub WebP, do 128 KB. Pliki
   SVG ze skryptami, odnośnikami lub osadzonymi treściami są odrzucane. Limit 50 plików na firmę
   (pliki są przechowywane jako historia).
2. **Szkic.** Nazwa marki (do 80 znaków, bez `<` i `>`), wybór logo i favicona, pięć kolorów
   (główny, tekst na kolorze głównym, tło, tekst, akcent; zapis `#RRGGBB`), styl nagłówka panelu
   rekrutera (w kolorze głównym albo jasny), nagłówek panelu kandydata (do 120 znaków) i opcjonalny
   wstęp (do 600 znaków). Pola nagłówka i wstępu kandydata służą tylko do podglądu (punkt 6).
3. **Kontrast.** Szkic jest odrzucany, gdy kontrast jest za słaby (WCAG: tekst co najmniej 4,5:1,
   akcent co najmniej 3:1). Kontrasty widać na bieżąco w formularzu.
4. **Podgląd i publikacja.** Podgląd panelu rekrutera i podgląd konfiguracji panelu kandydata (ten
   drugi nie jest jeszcze podłączony do ścieżki kandydata, patrz 6), potem „Opublikuj tę wersję”. Jeśli
   szkic zmienił się po wyświetleniu podglądu, trzeba obejrzeć podgląd ponownie.
5. **Historia i cofanie.** Każda publikacja to numerowana wersja; wcześniejszą można przywrócić jako
   nową wersję. Dziennik zmian pokazuje, kto co zmienił.

**Czego marka nie zmienia.** Informacje wymagane prawem (kto jest administratorem danych, kto jest
operatorem platformy, prawa osób, informacja o tym, że decyzję podejmuje człowiek) są stałą stopką
i nie da się ich zmienić ani pominąć.

**Raporty.** Strony raportów rekrutacji i raportu kandydata są objęte tą samą ramką marki (nagłówek
z logo i nazwą, kolory, stała stopka prawna). Wydruk lub „zapisz jako PDF” z przeglądarki zachowuje
nagłówek marki; na wydruku elementy w kolorach marki poza nagłówkiem są czarne na białym. Osobnego
generatora PDF z marką kod nie zawiera.

## 5. Co zostaje po stronie operatora i właściciela SkillCheck

Tych kroków klient nie wykona sam i nie wykonuje ich agent. Zasada: na Vercel Preview i w bazie
`skillcheck-preview` (dane testowe) działa operator; domeny, zmienne, sekrety i dane na produkcji
zmienia wyłącznie właściciel albo zatwierdzony pipeline:

| Krok | Kto | Uwagi |
|---|---|---|
| Włączenie `WHITE_LABEL_ENABLED=true` na produkcji | właściciel | zmiana ustawień produkcji Vercel; domyślnie wyłączone |
| Dodanie domeny klienta do projektu Vercel `skillcheck-core` na produkcji | właściciel (lub zatwierdzony pipeline) | operator tego nie robi: produkcyjne domeny w Vercel są decyzją właściciela. Bez tego domena nie otworzy aplikacji i certyfikat nie powstanie. Kod nie robi tego automatycznie (nie używa API Vercel). Czy dodanie domen pociąga koszt planu Vercel, sprawdza operator lub agent w trybie odczytu (plan konta i jego limity domen); właściciel dostaje dopiero pytanie TAK/NIE o zgodę na ustalony koszt, jeśli koszt jest |
| Podanie klientowi adresu docelowego (CNAME/A) po dodaniu domeny | operator | adres podaje właściciel albo pipeline po dodaniu domeny na produkcji; operator przekazuje go klientowi |
| Login bazy dla weryfikatora (`tenant_domain_verifier`) i adres `TENANT_DOMAIN_VERIFIER_DATABASE_URL` | Preview: operator (tylko `skillcheck-preview`, dane testowe). Produkcja: właściciel (lub zatwierdzony pipeline) | operator nie ustawia zmiennych ani sekretów na produkcji w Vercel. Bez tego przycisk „Sprawdź” odpowiada „Sprawdzanie domen nie jest dostępne w tym środowisku” (domyślnie bezpieczne wyłączenie) |
| Opcjonalnie: automatyczne ponawianie DNS (rola `tenant_domain_reverifier`, `TENANT_DOMAIN_REVERIFY_DATABASE_URL`, `TENANT_DOMAIN_REVERIFY_ENABLED=true`, harmonogram, np. raz dziennie) | Preview: operator. Produkcja: właściciel (lub zatwierdzony pipeline) | nieuruchomione; sekrety i harmonogram na produkcji to decyzja właściciela |
| Ustawienia domen (`subdomain_base`, `reverify_days`, `pending_days`, `max_domains_per_company`) | Preview: operator. Produkcja: właściciel (lub zatwierdzony pipeline) | wartości domyślne opisano w punkcie 3; zmiana danych na produkcji nie należy do operatora |
| Wgranie migracji SC-020 na produkcję | właściciel (zatwierdzenie `production-approval`) | stan produkcji sprawdź w git (SHA wydania na `main`), w PR i w wyniku workflow `db-migrate-production` dla tego SHA; obecność pliku migracji w repozytorium nie dowodzi jej wykonania; ten dokument nie podaje stanu produkcji |
| Dopuszczenie adresu domeny klienta w ustawieniach logowania Supabase (lista dozwolonych adresów zwrotnych) | Preview: operator; produkcja: właściciel lub zatwierdzony pipeline | do potwierdzenia: kod buduje adresy zwrotne logowania z hosta domeny klienta (`tenantOriginFromHeader`), a `lib/auth-url.ts` opisuje, że adresy spoza listy są podmieniane na adres główny. Dopóki nie sprawdzono tego na Preview, traktuj logowanie na domenie klienta jako niepotwierdzone |

## 6. Co nie jest zaimplementowane lub nie jest potwierdzone

- Brak automatycznego dodawania domeny w Vercel i brak sprawdzania rekordu CNAME/A; kod sprawdza
  tylko TXT i certyfikat TLS.
- Panel kandydata w marce klienta nie jest podłączony do realnej ścieżki kandydata: nagłówek i wstęp
  (`candidatePanel`) renderuje tylko podgląd na stronie marki. Opublikowana ramka marki
  (`BrandFrame`) jest w layoucie panelu rekrutera, a nie w widoku kandydata. Do czasu wdrożenia tej
  części kandydat nie zobaczy marki klienta w panelu zadania.
- Wysyłka wiadomości do kandydatów w marce klienta jest wyłączona: istnieją szablony i podgląd
  (zaproszenie do zadania, potwierdzenie zgłoszenia, zakończenie procesu), ale jedyny transport
  w kodzie odmawia wysyłki. Nadawca z domeny klienta (SPF/DKIM) nie istnieje. Realna wysyłka do
  kandydatów wymaga osobnej zgody właściciela.
- Automatyczne ponawianie DNS nie jest uruchomione (punkt 5).
- Test końcowy dwóch fikcyjnych marek na Preview (pierwszy wiersz R8 w `docs/ROADMAP.md`) nie jest
  jeszcze wykonany; ta instrukcja nie była więc jeszcze sprawdzona na żywej domenie.
- Kod nie definiuje wartości docelowej CNAME/A ani gwarancji czasu wystawienia certyfikatu; zależą
  od hostingu i dostawcy DNS klienta.
- Marka nie obejmuje własnego tekstu prawnego klienta ani zmiany stopki prawnej (celowo).

## 7. Lista kontrolna dla nowego klienta

1. Właściciel podpisuje umowę i wycenę (poza repozytorium). Operator sprawdza w docelowym środowisku (tylko odczyt)
   stan flagi `WHITE_LABEL_ENABLED` oraz wykonanie migracji SC-020 (sprawdzenie według punktu 5).
2. Właściciel firmy w SkillCheck ustawia markę (punkt 4) i publikuje ją.
3. Właściciel firmy dodaje domenę na stronie „Domeny” i przekazuje IT rekord TXT (punkt 2.1).
4. Domenę dodaje w Vercel właściciel SkillCheck (lub zatwierdzony pipeline); na Preview robi to
   operator. Operator przekazuje IT adres docelowy CNAME/A podany po dodaniu domeny (punkty 2.2 i 5).
5. IT wpisuje rekordy w DNS. Właściciel klika „Sprawdź” do skutku („Domena sprawdzona …”).
6. Właściciel klika „Włącz”. Rekord TXT zostaje na stałe; co 30 dni „Sprawdź” (punkt 3.3).
7. Sprawdzenie końcowe: logowanie na domenie klienta, wygląd panelu, wydruk raportu, historia zmian
   na stronie „Historia zmian marki i domen”.
