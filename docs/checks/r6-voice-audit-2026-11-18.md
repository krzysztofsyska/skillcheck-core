# R6 — audyt voicebota (architektura i MVP rozmowy), 18.11.2026

Krok ROADMAP: R6, wiersz 1 „Architektura i MVP rozmowy (dawne SC-011, SC-012)”.
Gałąź `claude/r6-voice-mvp-check`, baza `integration` @ `09babfd`.

## W skrócie

Fundamenty rozmowy są napisane i przetestowane, ale **tylko „na sucho”**: działają na
sztucznym dostawcy i na jednorazowej bazie testowej. Żadna część nie jest podpięta do
aplikacji, bazy preview ani produkcji. Prawdziwej rozmowy z kandydatem dziś nie da się
przeprowadzić — i tak ma zostać, dopóki voicebot nie działa.

## Co działa dziś (z udawanym dostawcą)

- **Sztuczny dostawca połączeń** (`lib/voice/fake-provider.ts`) — udaje zlecenie, sprawdzenie
  i anulowanie rozmowy; bez sieci, numerów i nagrań.
- **Plan rozmowy** z wyników preselekcji: wybór luk do dopytania, pytania z zatwierdzonego
  szablonu, zakazane tematy, limit 10 minut (`interview-plan.ts`, `screening-gap-selection.ts`,
  `template-registry.ts`).
- **Zgoda kandydata** na rozmowę (bez nagrywania) i sprawdzanie aktualnych danych z bazy
  (`interview-permission.ts`, `trusted-source-verifier.ts`).
- **Bramka pakietu** FREE / PRESELEKCJA: firma zweryfikowana, pakiet aktywny, limit nie
  wyczerpany, dostawca włączony (`mvp-package-gate.ts`). Sama w sobie niczego nie uruchamia.
- **Retell (docelowy dostawca)**: konfiguracja agenta w repo (`config/retell/`) ze sprawdzeniem
  offline, weryfikacja podpisu powiadomień, rejestr połączeń, jednorazowe zlecanie rozmowy
  (bez wbudowanego połączenia sieciowego), rozliczenie (tylko odbyta rozmowa zużywa limit),
  prośba kandydata „nie dzwońcie więcej” blokuje każdy kanał, usuwanie danych kandydata.
- **Testy**: 379 testów głosowych przechodzi lokalnie (378 + 1 po doinstalowaniu
  `react-test-renderer`, tak jak robi to CI) na jednorazowym lokalnym PostgreSQL 16.
  W CI chodzą w osobnych przepływach uruchamianych zmianą plików głosowych.

## Czego brakuje do MVP rozmowy

1. **Baza**: tabele głosowe są tylko w `db/isolated/*.sql` (12 plików), nie w migracjach.
   Nie ma ich w preview ani produkcji. Przeniesienie = migracje (L3) → produkcyjnie wymaga
   zgody właściciela, a automatyczny publikator migracji dziś nie wypuszcza (#491).
2. **Powiadomienia od dostawcy**: adres `/api/voice/retell/webhook` istnieje, ale celowo
   odpowiada 404 (`resolveRetellWebhookRuntime` zwraca `null`).
3. **Prawdziwe połączenie z Retell**: brak transportu; potrzebny klucz i numer telefonu —
   to nowy koszt, więc decyzja właściciela.
4. **Ekran dla rekrutera**: panel zatwierdzania planu (`components/voice/VoicePlanApprovalPanel.tsx`)
   nie jest nigdzie użyty.
5. **Wynik rozmowy w raporcie** dla rekrutera: transkrypty są tylko w bazie testowej
   (`sc011b3-voice-transcripts.sql`), bez ekranu i bez miejsca w raporcie.

## Czy klient coś widzi

- Znalezione i poprawione w tym PR: w panelu rekrutacji była porada „Nazwanie etapu „AI” lub
  „voicebot” nie uruchamia integracji”. Słowo „voicebot” usunięte, sens porady bez zmian.
- Poza tym nic: panel planu nie jest podpięty, webhook zwraca 404, dodatek „Rozmowa AI” jest
  wyłączony w kalkulatorze operatora, katalog cen nie zawiera rozmów, aneks o rozmowach
  głosowych jest wycofany, a testy strony głównej i raportu pilnują braku takich słów.

## Limity w pakietach (krok R6-2: FREE 1, płatne 10)

- Gotowe w bazie testowej (`db/isolated/sc019-voice-entitlements.sql`): pula rozmów na firmę,
  FREE dokładnie 1 i tylko raz na firmę, PRESELEKCJA z dowolną liczbą. Brak pakietów
  WERYFIKACJA i ASSESSMENT_CENTER i brak stałej „10”.
- **Dotyka zamrożonej ścieżki płatności — musi czekać na zniesienie zamrożenia**:
  dopisanie rozmów do katalogu pakietów i cennika (`pricing_catalog`, dodatek `interview`
  w `lib/pricing/internal-calculator.ts`), tekst oferty, przyznawanie 10 rozmów przy zakupie
  lub zmianie stanu zamówienia.
- **Można bez zamrożenia** (po R6-1c): pula jako migracja, przyznanie FREE 1 przez operatora,
  sprawdzanie limitu przy zlecaniu rozmowy — wszystko niewidoczne dla klienta.

## Proponowane małe kroki (kolejność)

- **R6-1a** — skrypt `npm run test:voice` zbierający wszystkie testy głosowe (bez nowych przepływów CI).
- **R6-1b** — `react-test-renderer` jako zależność deweloperska zamiast doinstalowywania w CI.
- **R6-1c** — tabele z `db/isolated/` jako migracje (L3; produkcja tylko za zgodą właściciela).
- **R6-1d** — panel planu rozmowy dla rekrutera za wyłączoną flagą, tylko w preview.
- **R6-1e** — transport i webhook Retell w preview z kontem testowym (nowy koszt → decyzja właściciela).
- **R6-2** — limity FREE 1 / płatne 10, w części niezależnej od zamrożenia płatności.
