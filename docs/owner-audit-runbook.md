# PR #1 — instrukcja domknięcia testów przez właściciela

Status początkowy: **NOT READY**. Ta instrukcja nie jest wynikiem testów. Każde pole PASS wymaga obserwacji i dowodu; brak próby oznacza BLOCKED, a odmienny wynik FAIL.

## 0. Przygotowanie (bez przekazywania sekretów)

1. Używaj wyłącznie Preview: https://skillcheck-core-git-feat-te-a48cba-krzysztofs-projects-b7ce87b5.vercel.app . Nie testuj na domenie produkcyjnej i nie wykonuj merge.
2. Zanotuj SHA z PR #1 i godzinę próby (Europe/Warsaw). Jeśli podczas prób zmieni się kod, zapisz, które kroki były na którym SHA.
3. Konto A jest właścicielem Ekoflame (1921aa90-a771-4a45-a9f9-ba0da10c04ea), konto B właścicielem TEST Firmy B (e732b9dc-ec23-4bcb-b06f-f7dd9fa2c0fb). Nie dodawaj A do B ani B do A. Obie firmy mają przygotowane syntetyczne dane w 13 tabelach i 3 widokach.
4. Do onboardingu i ról potrzebne jest dodatkowe kontrolowane konto C, z własną dostępną skrzynką. C nie może być właścicielem B. Najpierw wykonaj onboarding C, potem test ról w B. A/B pozostają rozłączne.
5. Użyj osobnych profili przeglądarki dla właściciela B i członka C. Dwie karty tego samego profilu dzielą sesję; samo otwarcie nowej karty nie izoluje kont.
6. Hasła wpisujesz wyłącznie sam w formularzach aplikacji lub ukrytym polu PowerShell. Nie przesyłaj haseł, kodów, linków recovery, ciasteczek ani plików HAR. Nie używaj Start-Transcript. Zrzuty rób po zakończeniu logowania, bez paska URL zawierającego kod.
7. Jeśli nie pamiętasz hasła B, wykonaj najpierw część 1. Nie zastępuj jej usunięciem konta, zmianą hasła w bazie ani wyłączeniem potwierdzeń e-mail.

## 1. Pełny password recovery (konto B)

1. Pozostaw działającą sesję B otwartą. Test przeprowadź w osobnym profilu przeglądarki, na stronie /forgot-password tego samego Preview.
2. Wpisz dokładny adres zarejestrowanego konta B i raz kliknij Wyślij instrukcję. Użyj właściwego adresu z `.biuro`, jeżeli dotyczy dotychczasowego konta testowego.
3. Oczekuj komunikatu o wysłaniu instrukcji. Jeśli wystąpi limit lub błąd, oznacz BLOCKED i zanotuj czas; nie klikaj wielokrotnie. Domyślna poczta i brak własnego SMTP są potwierdzonym ograniczeniem. Nie zakładaj, że sam komunikat sent dowodzi dostarczenia.
4. Sprawdź właściwą skrzynkę i spam. Oczekuj nowej wiadomości związanej z tą próbą. Otwórz link dokładnie w profilu, który wysłał żądanie (tam znajduje się PKCE). Nie kopiuj linku do czatu.
5. Oczekuj formularza /reset-password w Preview. Sam ustaw nowe hasło o długości 12–256 znaków i identyczne potwierdzenie. Zapisz je prywatnie w swoim menedżerze haseł. Nie używaj przykładowego hasła z dokumentacji.
6. Po zapisie oczekuj /dashboard i dostępu do własnej firmy. Wyloguj tę sesję przez przycisk Wyloguj się.
7. Wejdź ponownie bez logowania do panelu B: oczekuj przekierowania na /login i braku danych firmy. Zaloguj się nowym hasłem: oczekuj wyłącznie właściwej firmy B.
8. Jeżeli znasz poprzednie hasło, sprawdź jedną próbę starego hasła w oddzielnym wylogowanym profilu: musi zostać odrzucona. Jeśli starego hasła nie znasz, wpisz NIEWYKONANE; nie twierdź, że ten podpunkt przeszedł.
9. Otwórz ponownie użyty link recovery w wylogowanym profilu testowym: nie może utworzyć nowej sesji. Oczekuj błędu callbacku lub odmowy. Nie ujawniaj linku ani kodu w dowodzie.
10. Zapisz: odbiór e-maila TAK/NIE, właściwy origin, zapis nowego hasła, login nowym, logout/ochrona panelu, ponowne użycie linku. PASS tylko dla rzeczywiście wykonanych kroków; nierozstrzygnięty przypadek pozostaje otwarty.

## 2. Test dwóch kont A/B — rzeczywiste API

1. Otwórz Windows PowerShell. Wklej:

```powershell
powershell -NoProfile -File "C:\Users\krzys\.codex\.chatgpt-projects\g-p-6ab4c12a7600819180090653b84defda\skillcheck-core\scripts\run-live-check.ps1"
```

2. Supabase projektu wsvjawuikxfzjyivxgsu → Project Settings → API Keys: skopiuj publiczny Publishable key zaczynający się od sb_publishable_. Wklej tylko do pytania skryptu. Nie używaj secret ani service_role.
3. Podaj kolejno adres i aktualne hasło A, następnie adres i aktualne hasło B. Hasło nie jest wyświetlane; Enter zatwierdza. Nie zapisuj go w poleceniu ani pliku .env.
4. Poczekaj do końca. Oczekiwany wynik: PASS, dwa rzeczywiste logowania oraz 16 relacji. Skrypt wymaga własnego rekordu dla obu kont przed sprawdzeniem braku cudzych rekordów (64 zapytania kontrolne). Sam brak rekordów nie jest PASS.
5. Natychmiast wpisz `$LASTEXITCODE` — oczekiwane 0. Wynik 1, błąd sieci, brak danych lub nieudane logowanie oznacza brak zaliczenia, nawet jeśli wcześniejsze kroki działały.
6. Przekaż jedynie komunikat końcowy, kod wyjścia, SHA i czas. Zrzut ogranicz do wyniku, bez adresów/klucza z wcześniejszych pytań. Skrypt nie zapisuje danych firm i wylogowuje tylko utworzone przez siebie sesje.
7. Ten PASS dotyczy odczytów RLS. Nie zalicza zapisów, ról ani recovery.

## 3. Równoległy onboarding nowego konta C

1. Zarejestruj kontrolowane konto C w oddzielnym profilu, potwierdź e-mail, jeżeli jest wymagany, i zatrzymaj się na /onboarding PRZED pierwszym utworzeniem firmy. Sam wpisujesz hasło i akceptujesz ewentualne warunki.
2. Administrator w SQL Editor wykonuje poniższy SELECT po zastąpieniu ADRES_KONTA_C właściwym adresem. Nie publikuj adresu w repozytorium:

```sql
select u.id as user_id,
 (select count(*) from public.companies c where c.owner_id=u.id) as owned,
 (select count(*) from public.company_members m where m.user_id=u.id) as memberships
from auth.users u where lower(u.email)=lower('ADRES_KONTA_C');
```

Oczekuj dokładnie jednego użytkownika i owned=0, memberships=0. Inny stan nie testuje pierwszego onboardingu; użyj nowego kontrolowanego konta, nie usuwaj istniejących firm.

3. W /onboarding otwórz narzędzia deweloperskie przeglądarki (F12), Console. Poniższy kod, uruchamiany przez właściciela, wysyła dwa żądania istniejącego formularza równolegle, w bieżącej sesji. Nie odczytuje ciasteczek ani haseł. Utworzy testową firmę. Sprawdź kod przed uruchomieniem; nie wyłączaj zabezpieczeń przeglądarki przed wklejaniem — w razie blokady pozostaw próbę do nadzorowanego wykonania.

```javascript
(async () => {
  if (location.origin !== 'https://skillcheck-core-git-feat-te-a48cba-krzysztofs-projects-b7ce87b5.vercel.app' || location.pathname !== '/onboarding') throw Error('Niewlasciwa strona');
  // Świeży HTML formularza zawiera identyfikator akcji serwerowej Next.
  const html = await (await fetch('/onboarding', {cache:'no-store'})).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const form = Array.from(doc.forms).find(f => f.querySelector('input[name="name"]'));
  if (!form) throw Error('Brak formularza: konto moze juz miec firme');
  const seed = new FormData(form);
  if (![...seed.keys()].some(k => /^\$ACTION_(ID|REF)_/.test(k))) throw Error('Brak akcji serwerowej; nie wysylaj recznie zgadywanych danych');
  const label = 'TEST C onboarding ' + new Date().toISOString();
  const result = await Promise.all([1,2].map(async n => {
    const body = new FormData(); for (const [k,v] of seed) body.append(k,v);
    body.set('name', label);
    const start = performance.now();
    const response = await fetch('/onboarding', {method:'POST',body,credentials:'same-origin'});
    return {request:n,startMs:start,endMs:performance.now(),status:response.status,path:new URL(response.url).pathname};
  }));
  console.table(result);
  console.log('overlapping client requests:', Math.max(...result.map(r=>r.startMs)) < Math.min(...result.map(r=>r.endMs)));
})();
```

4. Oczekuj dwóch odpowiedzi kończących w /dashboard (status 200 po przekierowaniu) i overlapping client requests=true. To potwierdza nakładanie żądań klienta; nie jest pomiarem czasu wykonywania transakcji serwera. Błąd/inna ścieżka wymaga analizy, nie zaliczaj próby.
5. Ponów SELECT z kroku 2: owned=1. Sprawdź panel C: jedna firma TEST C onboarding. Zrób zrzut tabelki czasów bez sekretów i panelu. Dwie firmy oznaczają FAIL. Dwa ręczne kliknięcia bez dowodu nakładania nie wystarczą.
6. Odśwież /onboarding: przekierowanie do /dashboard, nadal jedna firma. Nie wywołuj ponownie create_company i nie usuwaj testowej firmy.

## 4. Owner / recruiter / viewer (C jako członek B)

Własna firma C nie przeszkadza; C NIE MOŻE być właścicielem B. Wpis viewer właściciela B nie zmienia jego efektywnych uprawnień, więc nie służy do testu viewer.

1. W profilu B otwórz firmę B, profil stanowiska i istniejące TEST zgłoszenie. Sprawdź zapis kontrolnej notatki etapu oraz jej trwałość po odświeżeniu (dopisz TEST OWNER z datą). To próba owner.
2. Administrator w Supabase odczytuje UUID C z SELECT powyżej i weryfikuje poniższym SQL, że C nie jest właścicielem B. Zastąp UUID_KONTA_C. Oczekiwane false:

```sql
select owner_id='UUID_KONTA_C'::uuid as is_owner
from public.companies where id='e732b9dc-ec23-4bcb-b06f-f7dd9fa2c0fb';
```

3. Właściciel świadomie nadaje C dostęp tylko do syntetycznej TEST Firmy B, uruchamiając poniższe. Nie wykonuj dla konta A, obcej osoby ani rzeczywistej firmy:

```sql
insert into public.company_members(company_id,user_id,role)
select id,'UUID_KONTA_C'::uuid,'recruiter' from public.companies
where id='e732b9dc-ec23-4bcb-b06f-f7dd9fa2c0fb' and owner_id <> 'UUID_KONTA_C'::uuid
on conflict(company_id,user_id) do update set role=excluded.role
returning company_id,role;
```

4. W profilu C odśwież /dashboard, otwórz TEST Firmę B. Recruiter powinien odczytywać dane i móc zapisać TEST RECRUITER w notatce etapu. Sprawdź po odświeżeniu. Powtórz zapis syntetycznej oceny zachowania, wersji zadania i obserwacji; w historii oczekuj autora C. W CV na syntetycznym tekście sprawdź edycję i zatwierdzenie. Nie oceniaj rzeczywistych osób.
5. Otwórz w C DWIE karty tej samej notatki etapu. W pierwszej pozostaw formularz otwarty przed zmianą roli. Administrator zmienia wyłącznie C w B:

```sql
update public.company_members set role='viewer'
where company_id='e732b9dc-ec23-4bcb-b06f-f7dd9fa2c0fb' and user_id='UUID_KONTA_C'::uuid
returning company_id,role;
```

6. Drugą kartę odśwież. Viewer ma widzieć dane, ale bez możliwości edycji. W pierwszej, starej karcie spróbuj zapisać TEST VIEWER DENIED. Oczekuj odmowy; następnie właściciel B potwierdza, że notatka NIE zmieniła się. Sam brak przycisku na nowej stronie nie dowodzi kontroli zapisu po stronie serwera.
7. Powtórz próbę starego formularza dla CV, oceny zachowania i obserwacji: przed każdą próbą tymczasowo nadaj C recruiter, otwórz formularz, zmień na viewer i dopiero wyślij. Sprawdź brak nowej wersji/zmiany jako B. Nie zmieniaj owner_id. Zapis przez viewer to FAIL.
8. Jako C spróbuj wejść bezpośrednio do firmy A: /dashboard/1921aa90-a771-4a45-a9f9-ba0da10c04ea . Oczekuj 404 i braku danych.
9. Sprawdź także API członkostw, osobno gdy C ma recruiter i gdy ma viewer. Uruchom w PowerShell:

```powershell
powershell -NoProfile -File "C:\Users\krzys\.codex\.chatgpt-projects\g-p-6ab4c12a7600819180090653b84defda\skillcheck-core\scripts\run-live-check.ps1" -Check Membership
```

W tym trybie pytanie o konto A oznacza CZŁONKA C, a pytanie o konto B oznacza właściciela TEST Firmy B. Nie używaj tu właściciela firmy A. Wpisz hasła prywatnie. Skrypt upewnia się, że B jest właścicielem, a C nim nie jest, próbuje zmienić własną rolę C i wykonać INSERT istniejącego członkostwa. Oczekiwane: odmowa zapisu i brak zmiany roli potwierdzony odczytem właściciela. Duplikat klucza NIE jest uznawany za dowód odmowy uprawnień. Nie dodaje nowej osoby. Jeśli wykryje nieoczekiwaną zmianę roli, próbuje przywrócić ją kontem właściciela i kończy FAIL; w razie nieudanej kontroli sam sprawdź rolę C w Supabase. Po każdym uruchomieniu sprawdź `$LASTEXITCODE` = 0 i komunikat PASS z właściwą rolą. Bez dwóch takich wyników pakiet ról pozostaje niezaliczony. Skrypt nie testuje wszystkich tabel operacyjnych: służą temu kroki formularzy 4–7.
10. Po próbach właściciel cofa wyłącznie tymczasowe członkostwo C w B (zapisz poprzednią rolę, aby móc odtworzyć wpis):

```sql
delete from public.company_members
where company_id='e732b9dc-ec23-4bcb-b06f-f7dd9fa2c0fb' and user_id='UUID_KONTA_C'::uuid
returning company_id;
```

Nie usuwa to użytkownika ani firmy C; dostęp można przywrócić INSERT-em z kroku 3. Po cofnięciu odśwież panel B jako C: oczekuj 404; jego własna firma pozostaje. Zapisz wynik.

## 5. Przekazanie wyniku i decyzja

Przekaż wyłącznie poniższą tabelę, godzinę, SHA i zanonimizowane dowody. Nie wysyłaj haseł, tokenów, recovery URL ani pełnego eksportu sieci.

| Próba | PASS / FAIL / BLOCKED | Dowód bez sekretów |
| --- | --- | --- |
| A/B 16 relacji | | wynik checkera + exit code |
| Recovery: poczta/callback/zapis/login/logout/link użyty | | lista wykonanych kroków |
| C równoległy onboarding | | czasy dwóch odpowiedzi + owned przed/po |
| Owner zapis | | odświeżony zapis |
| Recruiter zapis | | odświeżony zapis i historia |
| Viewer odmowa po zmianie roli | | odmowa + brak zmiany w sesji B |
| Recruiter/viewer brak zarządzania członkami API | | osobny nadzorowany test C |
| Cofnięcie członkostwa C | | 404 w B + własna firma C dostępna |

READY wolno nadać dopiero po zaliczeniu wszystkich wymaganych prób i analizie ewentualnych błędów na ustalonym SHA. Każdy BLOCKED/FAIL w wymaganej bramce oznacza NOT READY. READY nie jest zgodą na merge: zakaz scalania nadal obowiązuje.

