# SC-BULK-001 — zbiorcze wgrywanie i automatyczna segregacja CV

Stan: 2026-11-01. PR #228 → `integration` (+ PR #229: wgrywanie migracji na bazę testową).
Voicebot poza zakresem.

## Co robi
- Ekran rekrutacji → **Wgraj wiele CV**: PDF, DOCX, TXT, JPG/PNG lub ZIP. Limity: 100 plików w paczce,
  4 MB na plik (poniżej limitu 4,5 MB Vercel), ZIP do 100 MB, PDF do 20 stron, OCR do 6 stron.
- Podsumowanie przed startem: rekrutacja, liczba plików, CV pozostałe w pakiecie, ile zostanie
  przetworzonych, nadwyżka. Start dopiero po potwierdzeniu operatora.
- Pakiet: rezerwacja `min(pliki, dostępne)` w jednej transakcji z blokadą firmy (kolejność blokad
  SC-019). Nadwyżka = `over_limit`, bez przetwarzania, z linkiem do dokupienia piątki. Błąd lub
  duplikat zwraca miejsce (`bulk_release`). Start analizy przekazuje miejsce do niezmienionego
  naliczenia SC-019 (`bulk_transfer +1`, `analysis_reserve -1`); nieudana analiza wraca przez
  istniejący trigger SC-019. Zużycie = tylko ukończone analizy.
- Każdy plik to osobne żądanie; oryginał czytany wyłącznie w pamięci, nigdy nie zapisywany.
  Tworzy `candidates`, `candidate_documents`, `applications`.
- Kolejka AI: maks. 4 analizy na firmę i 12 globalnie (`private.cv_bulk_settings`), do 2 ponowień,
  ponowna wysyłka zgubionego zadania po 3 min.
- Duplikaty w rekrutacji: e-mail, telefon (9 ostatnich cyfr) lub wykryte imię i nazwisko.
- OCR lokalny (Tesseract + polski model z npm); skany PDF renderowane lokalnie. Nic nie idzie do
  zewnętrznego OCR. Niska pewność → „nieczytelny skan”.
- Statusy: oczekuje / przetwarzanie / gotowe / błąd (z powodem) + pasek postępu.
- Grupy (propozycja, `preselection-groups-v1`): dla wyników v2 (macierz dowodów) werdykty
  potwierdzone/częściowe/brak/sprzeczne = 100/50/0/0; dla v1 punkty ranking-v1 z progiem pokrycia 60%.
  ≥ 60 → przeszli sito, < 35 → nie spełniają kryteriów, reszta → decyzja rekrutera. Grupy nie zmieniają
  statusu zgłoszenia i nie tworzą wpisów shortlisty SC-008.
- Ręczne przeniesienie z historią (autor, czas, uzasadnienie); automat nie nadpisuje ręcznej decyzji.
- Brak telefonu jest wyraźnie oznaczony („voicebot nie zadzwoni”).
- E-mail po zakończeniu paczki (Resend; tylko liczby i link, bez danych kandydatów).
- Tokeny i koszt na każde CV; `cv_ai_usage_stats` (tylko operator) dla kalkulatora wycen.
- RODO: inwentarz usuwania R9 obejmuje nowe tabele; nazwy plików, które nie stały się kandydatem,
  są czyszczone po 30 dniach.

## Konfiguracja (wszystko domyślnie wyłączone / puste)
| Zmienna | Cel |
| --- | --- |
| `CV_BULK_MAIL_ENABLED=true` + `RESEND_API_KEY` | e-mail po paczce |
| `CV_AI_PRICE_INPUT_PER_MTOK`, `CV_AI_PRICE_OUTPUT_PER_MTOK`, opcj. `..._CACHED_INPUT_PER_MTOK`, `CV_AI_PRICE_CURRENCY`, `CV_AI_PRICE_VERSION` | koszt na CV (tokeny zapisują się zawsze) |
| `CV_BULK_CRON_SECRET`, `CV_BULK_WORKER_SECRET` (+ ten sam sekret w `private.cv_bulk_settings.worker_secret`) | przetwarzanie po zamknięciu karty: harmonogram woła `GET /api/internal/cv-bulk` co minutę (nie zarejestrowany) |
| `CV_OCR_LANG_PATH` (opcjonalnie) | inna lokalizacja polskiego modelu OCR |

## Migracje
`20261101100000_cv_bulk_intake.sql` → `20261101100100_cv_bulk_erasure_inventory_r9.sql`
(po R8). Rollbacki w `supabase/rollbacks/*cv_bulk*` (najpierw R9).
Produkcja: wyłącznie przez `db-migrate-production` po zgodzie właściciela.

## Testy
- `npm run test:cv-bulk` (jednostkowe, 8) i `npm run test:cv-bulk-db` (natywny PostgreSQL, pełny łańcuch migracji; w CI: SC-019 forward migrations, PG 16/17).
- `npm run test:pdf-bundle`: sprawdza też, że OCR i model są w paczce wdrożeniowej.
- Pełna regresja lokalnie: zielona.

### E2E na skillcheck-preview (2026-11-01, przeglądarka + aplikacja zbudowana lokalnie)
Syntetyczna paczka 60 plików (`scripts/create-bulk-cv-fixtures.mjs`), pakiet 55 CV:

| Sprawdzenie | Wynik |
| --- | --- |
| Podsumowanie | 60 plików, 55 w pakiecie, 5 poza limitem, propozycja dokupienia |
| Wysyłka 60 plików | 23 s |
| Przyjęte | 48 (w tym 7 z OCR: zdjęcia JPG i skany PDF) |
| Duplikaty | 5 wykrytych, miejsca zwrócone |
| Nieczytelne skany | 2 → błąd z powodem, miejsca zwrócone |
| Poza limitem | 5, nieprzetworzone |
| Kolejka | 4 analizy naraz |
| Analiza AI | symulowana (bez OpenAI) zgodnie z kontraktem workera v2; tokeny 3000/600 |
| Pakiet po paczce | zarezerwowano 55, zwrócono 7, zużyto 48 |
| Grupy | 13 / 18 / 17; 12 osób bez telefonu oznaczonych |
| Ręczne przeniesienie | zapisane z autorem, czasem, uzasadnieniem; oznaczone „przeniesiony ręcznie” |
| Status zgłoszeń / shortlista | bez zmian / brak automatycznych wpisów |
| Błędne pliki (osobna paczka) | zabezpieczony PDF, uszkodzony PDF, .doc, pusty TXT, pusta strona → właściwe powody, wszystkie miejsca zwrócone |
| E-mail | wyłączony → `skipped` (bez wysyłki) |
| Inwentarz RODO | podpis schematu zgodny z R9 |

Błąd znaleziony przez E2E i poprawiony: w zbudowanej aplikacji ścieżka do polskiego modelu OCR
była zamieniana przez bundler na identyfikator modułu → OCR nie działał, a skan PDF był mylnie
raportowany jako „zabezpieczony”. Poprawka + test w `test:pdf-bundle`.

Nie przetestowano na preview: prawdziwego wywołania OpenAI (brak wdrożonego workera na preview,
osobny koszt), wysyłki e-mail, harmonogramu w tle.

## Decyzje właściciela (2026-11-01) — wszystkie TAK
1. W trybie zbiorczym potwierdzenie paczki przez operatora zastępuje ręczne sprawdzenie
   anonimizacji każdego CV (`reviewed_by` = operator, automatyczne zakrycie imienia, nazwiska,
   e-maila, telefonu i linków).
2. Progi grup na start: ≥ 60 przeszli sito, < 35 nie spełniają kryteriów, reszta decyzja rekrutera.
3. Przetwarzanie w tle po zamknięciu strony: harmonogram GitHub co 5 min
   (`.github/workflows/cv-bulk-pump.yml`, tylko `main`) woła `/api/internal/cv-bulk`.
   Nie Vercel Cron: zadania co minutę wymagają płatnego planu Vercel i na planie Hobby blokują wdrożenie.
4. E-mail do operatora po zakończeniu paczki — włączany przy wdrożeniu produkcyjnym.
5. Jednorazowy test z prawdziwą analizą AI na bazie testowej: `.github/workflows/preview-ai-smoke.yml`
   (gałąź `preview-ai/**`, maks. 10 analiz, tylko firmy „Firma Testowa…”).
6. Osobne zadanie: produkt „dokup 5 CV” w SC-019.

## Lista kroków przy wdrożeniu produkcyjnym (po osobnym TAK na produkcję)
Wykonuje właściciel albo zatwierdzony pipeline — agenci nie zmieniają sekretów produkcji.
1. Migracje: R8 (jeśli jeszcze nie ma) → `20261101100000_cv_bulk_intake.sql` → `20261101100100_cv_bulk_erasure_inventory_r9.sql`
   przez `db-migrate-production`.
2. Vercel Production env: `CV_BULK_WORKER_SECRET` (≥ 32 znaki), `CV_BULK_CRON_SECRET` (≥ 32 znaki),
   `CV_BULK_MAIL_ENABLED=true` (używa istniejącego `RESEND_API_KEY`), `CV_AI_PRICE_INPUT_PER_MTOK`,
   `CV_AI_PRICE_CACHED_INPUT_PER_MTOK`, `CV_AI_PRICE_OUTPUT_PER_MTOK`, `CV_AI_PRICE_VERSION` (cennik OpenAI
   dla modelu `gpt-5.4-mini-2026-03-17` z dnia wdrożenia).
3. Baza produkcyjna (zatwierdzony krok SQL): `update private.cv_bulk_settings set worker_secret = '<CV_BULK_WORKER_SECRET>' where singleton;`
4. GitHub: środowisko `cv-bulk-pump` z sekretem `CV_BULK_CRON_SECRET` (ta sama wartość co w Vercel).
5. Smoke po wdrożeniu: paczka 3 syntetycznych CV na koncie testowym, przebieg do „gotowe”, e-mail, wpis tokenów i kosztu.
