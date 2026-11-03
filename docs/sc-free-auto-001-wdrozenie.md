# Automatyczne FREE i zgoda na kontakt handlowy — jak to włączyć

Dokument dla właściciela. Opisuje, co trzeba ustawić, żeby trzy rzeczy z tej
zmiany zaczęły działać na produkcji:

1. **Automatyczne FREE** — nowa firma podaje NIP, sprawdzamy go w wykazie
   podatników VAT Ministerstwa Finansów i jeśli firma tam jest, pakiet FREE
   włącza się od razu, bez klikania przez obsługę.
2. **Zgoda na kontakt handlowy** — osobny, nieobowiązkowy checkbox przy
   rejestracji, z historią zgód w panelu firmy.
3. **Codzienne podsumowanie** — jeden wewnętrzny e-mail o 19:00, z samymi
   liczbami (ile nowych firm, ile FREE, ile czeka na sprawdzenie).

**Nic z tego nie włączy się samo.** Do czasu wykonania kroków poniżej wszystko
działa dokładnie jak dziś: FREE przyznaje ręcznie obsługa w `/operator/billing`.
Zgoda przy rejestracji nie zapisze się bez klucza z punktu 2 — firma może ją
wtedy zaznaczyć jednym kliknięciem w panelu (`Zgody na kontakt handlowy`).

Kolejność jest ważna. Punkty 1–4 można zrobić w jednej sesji.

---

## 1. Migracje bazy

Przez workflow `db-migrate-production`, w tej kolejności, nigdy `supabase db push`:

1. `20261103090000_sc19_auto_trial_marketing_consent.sql`
2. `20261103090100_sc_erasure_inventory_r11.sql`

Druga jest obowiązkowa zaraz po pierwszej. Między nimi usuwanie danych na
żądanie jest zablokowane (celowo, żeby nic nie wykonało się „na pół").

## 2. Zmienne w Vercel (Production)

Dodaj, wszystkie jako **Sensitive**:

| Zmienna | Wartość |
| --- | --- |
| `SC19_TRIAL_AUTO_SECRET` | losowy ciąg, co najmniej 32 znaki |
| `SC19_DIGEST_CRON_SECRET` | losowy ciąg, co najmniej 32 znaki, **inny** niż powyższy |
| `SC19_DIGEST_ENABLED` | `true` (dopiero gdy chcesz dostawać e-mail) |
| `SC19_DIGEST_RECIPIENT` | jeden wewnętrzny adres, na który ma przyjść podsumowanie |
| `SC19_DIGEST_SENDER` | adres nadawcy zweryfikowany w Resend |

`SC19_TRIAL_AUTO_SECRET` to ten sam klucz, który podpisuje zgodę z rejestracji.
Bez niego automatyczne FREE nie zadziała i zgoda z rejestracji się nie zapisze.

Nie dodawaj `CRON_SECRET` — harmonogram nie idzie przez Vercel Cron (patrz
punkt 4).

Po dodaniu zmiennych zrób **Redeploy** produkcji.

## 3. Ten sam klucz w bazie (zatwierdzony krok SQL)

Baza musi znać ten sam `SC19_TRIAL_AUTO_SECRET`, żeby sprawdzić podpis. Jedno
polecenie, z tą samą wartością co w Vercel:

```sql
select private.rotate_sc19_trial_auto_secret('<ta sama wartość co SC19_TRIAL_AUTO_SECRET>');
```

To jedyny obsługiwany sposób ustawienia tego klucza. Funkcja sprawdza długość
(min. 32 bajty), zapisuje datę zmiany i czyści stare identyfikatory żądań.
Tej samej komendy używa się przy każdej późniejszej zmianie klucza: zmień
wartość w Vercel, zrób redeploy, potem uruchom tę komendę z nową wartością.

Wartości nie wpisuj do żadnego pliku, zgłoszenia ani czatu.

## 4. Harmonogram codziennego podsumowania (GitHub)

Utwórz w GitHubie środowisko `sc19-daily-digest` z jednym sekretem:

- `SC19_DIGEST_CRON_SECRET` — **ta sama wartość** co w Vercel.

Harmonogram jest już w repozytorium
(`.github/workflows/sc19-daily-digest.yml`) i odpala się sam. Dopóki sekret nie
istnieje, zadanie tylko wypisuje notkę i nic nie robi.

Dlaczego GitHub, a nie Vercel Cron: Vercel wkłada do żądania wartość zmiennej
nazwanej dokładnie `CRON_SECRET` i nic innego, a dwa odpalenia dziennie dla
jednej ścieżki wymagają płatnego planu. Płatny plan to nowy koszt, czyli Twoja
decyzja, a GitHub Actions nic nie kosztuje i tak samo działa już przy paczkach CV.

### Co znaczą liczby w tym mailu

- **Nowe firmy** — firmy zarejestrowane w ciągu ostatniej doby.
- **FREE przyznany automatycznie** — ile razy wykaz VAT potwierdził firmę i FREE
  włączyło się samo.
- **Czeka na ręczne sprawdzenie** — firmy, które w ciągu tej doby **same
  poprosiły** o FREE (podały NIP w panelu) i nadal nie mają zatwierdzenia: ani
  automat ich nie potwierdził, ani nikt nie zatwierdził ich ręcznie. Nie są tu
  liczone firmy, które o FREE nigdy nie prosiły, ani te, które mają już pakiet
  płatny. Dopóki automat jest wyłączony, **każde** zgłoszenie NIP-u ląduje w tej
  liczbie — i tak ma być, bo właśnie takie zgłoszenia trzeba przejrzeć ręcznie.
  To liczba zgłoszeń z tej doby, nie całej zaległej kolejki; pełna lista jest w
  `/operator/billing`.
- **Zgoda na kontakt handlowy** — ile zgód zostało udzielonych w tej dobie,
  licząc po **dacie wyrażenia zgody** przez klienta (a nie po dacie, kiedy
  zapisaliśmy ją przy firmie — te dwie chwile mogą się różnić o kilka dni, jeśli
  klient potwierdzał e-mail z opóźnieniem).

## 5. Włączenie automatu

Dopiero teraz, w `/operator/billing`, sekcja **Automatyczne FREE z wykazu VAT**:
wybierz „włączony", zaznacz potwierdzenie, zapisz. Strona pokazuje też, czy klucz
podpisu jest ustawiony — jeśli nie, automat i tak nic nie przyzna.

Przed włączeniem upewnij się, że liczba analiz w pakiecie FREE jest ustawiona
(sekcja **Liczba analiz w pakietach**, FREE = 5). Bez tego każda analiza jest
odrzucana.

## 6. Sprawdzenie po włączeniu

1. Na koncie testowym: rejestracja z zaznaczonym checkboxem zgody → firma →
   `Pakiety` → NIP prawdziwej, istniejącej firmy → FREE włącza się od razu.
2. `/operator/billing` → **Automatyczne sprawdzenia w wykazie VAT**: jest wpis
   „FREE przyznany" z tym NIP-em.
3. Ta sama firma, inny NIP → odmowa z powodem „to konto próbowało już innego
   NIP-u". Tak ma być.
4. Panel firmy → `Zgody na kontakt handlowy`: zgoda aktywna, przycisk wycofania
   działa, po wycofaniu widać datę. Po wycofaniu zgodę można udzielić ponownie
   tym samym przyciskiem w panelu — w rejestrze zapisze się wtedy jako „z panelu
   firmy", nigdy jako „z rejestracji". Wpis „z rejestracji" może być w rejestrze
   firmy tylko jeden i tylko jako pierwszy; pilnuje tego baza danych, żeby
   rejestr zgód pozostał dowodem, kiedy i gdzie klient zgodę naprawdę wyraził.

   Data przy zgodzie „z rejestracji" to **chwila, w której klient zaznaczył
   okienko przy zakładaniu konta**, a nie chwila, w której utworzył firmę. Te
   dwie mogą się różnić o kilka dni, jeśli klient potwierdzał adres e-mail z
   opóźnieniem — a rejestr zgód ma dowodzić, kiedy zgoda naprawdę została
   wyrażona. Data jest objęta podpisem, więc nikt nie może jej sobie wybrać.
   Gdyby przyszła data niemożliwa (z przyszłości albo starsza niż 90 dni), zgoda
   **nie przepada** — zapisuje się z datą bieżącą.
5. Następnego dnia po 19:00: jeden e-mail z liczbami na adres z
   `SC19_DIGEST_RECIPIENT`.
6. NIP, którego wykaz nie potwierdził, od razu drugi raz → komunikat „odczekaj
   około 5 minut i spróbuj ponownie". Tak ma być: wykaz Ministerstwa Finansów ma
   niski dzienny limit zapytań wspólny dla wszystkich firm, więc nie pytamy o tę
   samą firmę kilka razy pod rząd. Po tych kilku minutach ta sama firma może
   spróbować jeszcze raz i normalnie dostać FREE — to spowolnienie, nie blokada.
7. To samo dotyczy zgłoszeń wysłanych **równocześnie** (np. kilka otwartych kart
   przeglądarki): do wykazu idzie jedno zapytanie, pozostałe dostają ten sam
   komunikat „odczekaj około 5 minut".

   Przy **każdym** sprawdzeniu system najpierw zapisuje rezerwację, a dopiero
   potem pyta wykaz — więc w rejestrze (zapisywanym raz na zawsze, nic się z
   niego nie usuwa) zawsze stoi najpierw wpis „sprawdzenie rozpoczęte, bez
   odpowiedzi wykazu", a po nim właściwy wynik. W `/operator/billing` widzisz
   **jeden wiersz na jedno zdarzenie**: gdy odpowiedź wykazu już jest, lista
   pokazuje tylko ją. Wpis „sprawdzenie rozpoczęte, bez odpowiedzi wykazu"
   zostaje na liście wtedy, gdy odpowiedzi nie ma — czyli przy zgłoszeniach
   równoczesnych albo gdy wykaz nie odpowiedział. To zarezerwowana próba, nie
   błąd; nie odbiera firmie jej jednego NIP-u i wygasa po kilku minutach.

## 7. Co zrobić, gdy ktoś zajmie NIP cudzej firmy

NIP jest publiczny, więc ktoś może podać NIP firmy, której nie reprezentuje, i
zająć jej jedyne FREE. Jedno konto może spróbować automatycznie tylko jednego
NIP-u, ale jednorazowo da się tak zrobić.

Jak to naprawić: `/operator/billing` → sekcja **Zajęte NIP-y** → znajdź NIP →
„Zwolnij ten NIP" → wpisz, co sprawdzono i kiedy → zapisz. Prawdziwa firma może
potem normalnie aktywować FREE.

Zwolnienie **nie odbiera** analiz już przyznanych tamtej firmie. Odebranie
analiz to operacja rozliczeniowa i wymaga Twojej decyzji.

### Zwolniony NIP nie wraca do poprzedniego konta

Po zwolnieniu konto, któremu NIP odebrano, **nie może zająć go ponownie** —
dostanie odmowę i trafi do ręcznego sprawdzenia. Wcześniej mogło: zwolnienie
usuwało zatwierdzenie, ale nic nie pamiętało, że ten NIP temu konkretnemu kontu
odebrano, więc poprzedni posiadacz mógł zgłosić ten sam NIP jeszcze raz i zdążyć
przed prawdziwą firmą. Prawdziwa firma to inne konto i jej to nie dotyczy —
aktywuje FREE normalnie.

### Gdy zwolniłeś NIP przez pomyłkę

Jeśli NIP został zwolniony omyłkowo i ma wrócić do **tego samego** konta:
`/operator/billing` → znajdź tę firmę na liście → rozwiń **„Zweryfikuj firmę
przed FREE"** → wpisz jej NIP i dowód weryfikacji → zaznacz oświadczenie →
**„Zatwierdź weryfikację"**. To ręczne zatwierdzenie zdejmuje blokadę i firma
może aktywować FREE. Automat sam blokady nie zdejmie — musi to być świadoma
decyzja operatora, zapisana z dowodem.

## 8. Jak to wyłączyć

- Automatyczne FREE: `/operator/billing` → „wyłączony". Działa od razu, nic nie
  trzeba wdrażać. Przyznane FREE zostaje.
- Codzienne podsumowanie: `SC19_DIGEST_ENABLED=false` w Vercel + redeploy, albo
  usunięcie sekretu ze środowiska `sc19-daily-digest` w GitHubie.
- Zgoda na kontakt handlowy: nie ma wyłącznika i nie jest potrzebny — nic nie
  jest nikomu wysyłane, zgoda jest tylko zapisywana.
