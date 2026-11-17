# SkillCheck — dziennik decyzji właściciela

## Zasady tego pliku

1. Tu, i tylko tu, zapisujemy decyzje właściciela (Krzysztof): data, godzina, dosłowny cytat, czego
   dotyczy. Agent nie streszcza decyzji własnymi słowami i niczego do cytatu nie dopisuje.
2. `docs/ROADMAP.md`, `AGENTS.md` i `CLAUDE.md` zawierają tylko obowiązującą regułę, bez cytatów.
   Gdy reguła i wpis tutaj się różnią, rozstrzyga najnowsza wiadomość właściciela.
3. Wpisy są dopisywane na górze sekcji danego dnia. Starsze wpisy zostają jako historia; nieaktualne
   oznaczamy dopiskiem „NIEAKTUALNE (data)”, nie kasujemy.
4. Starsza historia (do 15.11.2026) jest w historii git oraz w `docs/BACKLOG.md` (archiwum).

## 17.11.2026

**Porządek dokumentów pracy (ten plik, ROADMAP, AGENTS, CLAUDE).** Czat zaproponował: jedna
roadmapa z kolejnością, osobny dziennik decyzji, krótkie AGENTS.md i CLAUDE.md, statusy
aktualizowane przez wykonawcę w PR kończącym krok. Właściciel, 17:07: „przygotuj wszystkie trzy
dokumenty aby były wykonawczo zbieżne”.

**Porządki przyspieszające pracę (J3).** 10:41 „W takim razie robimy tylko punkty 1,2,3,5” —
w odpowiedzi na plan czatu, w którym punkt 2 brzmiał: „Zlecam w skillcheck-core usunięcie starego
automatu i poprawkę instrukcji”. 14:26 „1 tak” — na pytanie czatu: „Czy wykreślić J4 (podział
testów) z zadania porządkowego i zostawić tylko usunięcie starego automatu?”

**Automatyczne wgrywanie bezpiecznych zmian bazy (J1, issue
[#491](https://github.com/krzysztofsyska/skillcheck-core/issues/491)).** Droga B w czacie brzmiała:
„B. Automat dla bezpiecznych zmian — Zmiany, które tylko dodają (nowa tabela, nowa kolumna), idą
same po sprawdzeniu świeżej kopii; kasujące lub przerabiające dane dalej czekają na Ciebie”.
Właściciel:

- 07:20 „Na pierwsze pytanie to będzie B”
- 07:25 „Część pierwsza to uruchom.”

**Gwarancja PRESELEKCJI (J2, issue
[#492](https://github.com/krzysztofsyska/skillcheck-core/issues/492)).** Właściciel:

- 07:25 „Jest powtórka połączona ze zwrotem. Najpierw poprawiamy za darmo, a jeżeli nie pasuje,
  oddajemy pieniądze. […] Minimum 5 kandydatów.”
- 07:49 „Ok” — w odpowiedzi na trzy doprecyzowania czatu: kandydat „wart rozmowy” spełnia wszystkie
  wymagania konieczne klienta; zwrot dopiero po powtórce z udziałem klienta; gwarancja działa także
  przy słabym naborze, ale tylko dla pierwszych 20 firm.
- 07:53 „Termin zgłoszenia gwarancji to 7 dni od otrzymania raportu. Zapis o gwarancji nie idzie do
  prawnika, tylko od razu do polityki.”
- 07:56 „Musi zostać załadowana do obu baz, i zarówno do skill check core, jak i skill check
  preselekcja. Dobrze, przeniesiemy go przy okazji podłączenia Stripe'a.”

Uwaga: „[…]” to skrót w poleceniu właściciela, z którego pochodzi cytat; pełniejszego brzmienia
w repozytorium nie ma.

## 16.11.2026

**Kierunek sprzedaży i budowy.** Czat przedstawił poniższe rekomendacje, właściciel odpowiedział
**„tak jak polecasz”** (22:39):

- „Gdzie sprzedajemy najpierw. Polecam FREE i PRESELEKCJĘ z nowej aplikacji skillcheck-preselekcja
  na Stripe, a w skillcheck-core budowę WERYFIKACJI i Assessment Center.”
- „Pakiety na stronie. WERYFIKACJA i Assessment Center zniknęły ze strony tylko z powodu
  Przelewy24. Skoro z P24 rezygnujesz, polecam je przywrócić z cenami 615 zł i 1 499 zł.”
- „Voicebot. Rozumiem to tak: docelowo w każdym pakiecie (FREE 1 rozmowa, płatne 10), budowany na
  końcu, do tego czasu niewidoczny na stronie.”
- „Zatwierdzanie testów. 6 listopada zdecydowałeś, że rekruter może puścić testy automatycznie (…).
  Poprawię zapis na Twoją wersję.”
- „White-label i bramka AI (SC-020, SC-021). Polecam wstrzymać je do pierwszej sprzedaży.”

Uwaga: „(…)” to skrót samej rekomendacji czatu w poleceniu, z którego pochodzi cytat; pełniejszego
brzmienia w repozytorium nie ma. Dosłowną odpowiedzią właściciela na wszystkie pięć pozycji jest
wyłącznie „tak jak polecasz”.

**Promocja `integration → main` scalana przez recenzenta.** 15:19 (potwierdzone 15:21 i 18:47):
„Sesja recenzenta może scalić promocję integration → main, gdy testy są zielone na dokładnej wersji
i jest niezależna ocena pozytywna. Bez zmian zostają: zamrożenie płatności, zakaz zmiany sekretów
i ustawień, zakaz kasowania danych i nowych kosztów.” Wiadomość z 18:47: „sesja recenzenta może sama
scalić wydanie na produkcję”.

**Wydania bez kliknięć właściciela (#369).** Właściciel zdecydował w swojej wiadomości
(https://claude.ai/code/session_01TVLzgcKNUtgiz4KTVzeVwF), że żaden krok wydania nie może wymagać
jego kliknięcia, zatwierdzenia ani ręcznego uruchomienia. Szczegóły:
[docs/continuous-release-policy.md](continuous-release-policy.md).

**Bramka workera.** Zapis „Accepted cost (owner, 2026-11-16)” w PR #460 wpisał czat, nie właściciel.
Bramka `WORKER_DEPLOY_REQUIRED` zostaje tymczasowo, do ukończenia
[#461](https://github.com/krzysztofsyska/skillcheck-core/issues/461).

**Rezygnacja z Przelewy24.** Właściciel zrezygnował z Przelewy24; sprzedaż FREE i PRESELEKCJI ze
Stripe idzie w `krzysztofsyska/skillcheck-preselekcja`. Sekcja AGENTS.md o Sandboxie Przelewy24
z 11.11.2026 jest NIEAKTUALNA (16.11.2026) i została usunięta; jej treść jest w historii git.

## 15.11.2026 i wcześniej — skrót historii (nie cytaty)

Poniższe linie to skrót przeniesiony z dawnych zapisów w `AGENTS.md` i `CLAUDE.md`, nie cytaty.
Dosłowne brzmienie jest w historii git tamtych plików.

- 15.11.2026: HOLD P24 zdjęty jako blokada wydań; zastąpiony zamrożeniem ścieżki płatności
  (obowiązuje — zob. `AGENTS.md`, „Continuous release policy”).
- 06.11.2026: rekruter może puścić testy kompetencji automatycznie (potwierdzone 16.11.2026 wyżej).
- 05.11.2026: rola wykonawcy przypisana Codexowi — NIEAKTUALNE (17.11.2026): kod pisze sesja
  wykonawcy Claude Code, ocenia osobna sesja recenzenta.
- 01.11.2026: uwagi bezpieczeństwa zawsze poprawiane na gałęzi przed scaleniem; rutynowe kroki
  agent wykonuje sam i raportuje; raport statusu na Dysk Google po każdej sesji.
- 29.10.2026: tożsamość GitHub sesji agentów, wariant B (zob. `AGENTS.md`, Production access rule 5).
