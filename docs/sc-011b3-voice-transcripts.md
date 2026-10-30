# SC-011-B3 — transkrypcje rozmów voice z retencją 90 dni

TASK: SC-011-B (#79), krok B3 | SCOPE: BACKEND | LEVEL: L3 | REVIEWER: niezależny Codex
STATUS: IZOLOWANY SCHEMAT (tylko testowa baza) | PRODUCTION_APPROVAL: NO | DB/MIGRATIONS: brak migracji; `db/isolated/sc011b3-voice-transcripts.sql`

## Po co

Transkrypcja to jedyny zapis odpowiedzi kandydata. Retell przy `basic_attributes_only` jej nie przechowuje. Jest potrzebna do analizy z dowodami (SC-013, #14), do wglądu rekrutera i do obsługi odwołań.

**Decyzja właściciela (2026-10-30):** transkrypcję przechowujemy, dopóki rekrutacja nie jest zamknięta, i jeszcze **90 dni po jej zamknięciu**. Potem jest usuwana.

## Co dochodzi

- `private.sc011b_voice_transcripts`: jedna transkrypcja na próbę połączenia.
  - Format to `utterances` = `[{speaker: "agent"|"candidate", text}]`, już zminimalizowane w B1. Bez numerów, nagrań, zmiennych i analizy AI.
  - Limity: maksymalnie 400 wypowiedzi i 256 KiB.
  - Firmę, kandydata i rekrutację wyzwalacz bierze z rekordu wysyłki, a nie od wywołującego.
  - Zapis jest możliwy tylko dla próby w stanie `completed`.
  - Wiersza nie da się zmienić. Usunąć go może tylko funkcja retencji.
  - RLS z `force` i brak grantów (jak SC-010-C i B2).
- `ingestRetellWebhook` zapisuje transkrypcję w tej samej transakcji, w której `call_ended` ustawia status `completed`. Dotyczy to także rozmowy zakończonej prośbą o DNC. Poczta głosowa, brak odpowiedzi, zajęte i błędy nie zostawiają transkrypcji.
- `private.sc011b_purge_voice_transcripts()` usuwa transkrypcje rekrutacji ze statusem `closed`, gdy `closed_at` jest co najmniej 90 dni temu. Ponowne otwarcie rekrutacji wstrzymuje usuwanie. Próba połączenia i jej wynik zostają. Funkcja zwraca liczbę usuniętych wierszy.

## Zanim trafi do produkcji

1. Migracja razem ze schematami SC-010-C i B2 oraz **adapter usuwania i przywracania** w inwentarzu SC-010. Żądanie usunięcia danych przez kandydata musi kasować transkrypcję wcześniej niż po 90 dniach.
2. Zaufany harmonogram wywołujący funkcję czyszczącą, np. codziennie, z rolą bez innych uprawnień.
3. Odczyt dla rekrutera i SC-013 przez kontrolowany interfejs serwera, z autoryzacją firmy.
4. Opis okresu przechowywania w informacji dla kandydata i potwierdzenie prawne.

## Testy

Prawdziwy PostgreSQL (`tests/retell-dispatch-ledger.test.mjs`, `tests/voice-preparation-privileges.test.mjs`). Testy obejmują:
- zapis zminimalizowanej transkrypcji po rozmowie zakończonej DNC, z poprawną rekrutacją i kandydatem i bez numeru;
- niezmienność wiersza;
- brak transkrypcji przy braku odpowiedzi, poczcie i zajętym numerze;
- odmowę zapisu dla niezakończonej próby;
- retencję: rekrutacja otwarta i zamknięta 89 dni temu → zostaje; ponownie otwarta → zostaje; zamknięta 91 dni temu → usunięta, a próba zostaje;
- RLS i brak uprawnień dla wrogich ról.
