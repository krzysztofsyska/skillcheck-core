# SC-014 — Test kompetencji: kontrakt i etap A

TASK: SC-014, LEVEL: L3, SCOPE: BACKEND domain contract, STATUS: PR_REVIEW (partial implementation)
DEPENDS ON: SC-008 (merged to integration)

## Cel
Kandydat odpowiada na zadanie ze wskazanej, **niezmiennej** wersji definicji (`exercise_definition_entries.id`); rekruter ocenia odpowiedź po opisach zachowań i wskazuje konkretny cytat dowodowy. Wynik wspiera decyzję człowieka, nie podejmuje decyzji zatrudnieniowej.

## Etap A — implementacja lokalnej logiki (ten PR)
- Wykorzystuje istniejący `parseExerciseDefinition`; tylko `kind=competency_test`.
- `candidateTestView(revision)` wydaje bezpieczny DTO: id wersji, numer wersji, tytuł, instrukcję, rezultat, czas. Rubryka, autor, metadane firmy, zapisy ocen nie są udostępniane kandydatowi. Funkcja **nie autoryzuje** dostępu: caller musi najpierw zweryfikować uprawnienie do dokładnej wersji.
- `parseCompetencyTestSubmission(definition, payload)` przyjmuje tylko `workSample` 1–20 000 punktów kodowych Unicode surowego wejścia, liczonych przed `trim()`; znak spoza BMP zajmuje jeden punkt, a znaki łączące i formatowanie również wliczają się do limitu. Wstępny limit 40 000 jednostek UTF-16 ogranicza koszt skanowania bez zmniejszania dopuszczalnej długości odpowiedzi. Odpowiedź musi zawierać znaczącą, widoczną treść; tekst jest przycinany przez ECMAScript `trim()` bez dodatkowej normalizacji. Parser usuwa ignorowane pola typu tenant/autor/wynik/timer z klienta; nie zapisuje nic do bazy.
- Kontekstowe formatowanie pisma i emoji jest zachowywane w odpowiedzi i dokładnych cytatach. Flagi z tagami dopuszczamy jako pełne sekwencje Unicode `RGI_Emoji_Tag_Sequence` (Anglia, Szkocja, Walia), z wymaganym terminatorem; tagi nie zwiększają liczby widocznych znaków cytatu. Samodzielne tagi, sekwencje niepełne i nierozpoznane pozostają niedozwolone.
- `evaluateCompetencyTest(definition, answer, observations)` to jawna, deterministyczna ocena przekazana przez uprawnionego człowieka. Ocenę `below/meets/above` musi wspierać dokładny cytat z odpowiedzi (min. 3 znaki). `insufficient_data` nie obniża punktacji i nie może mieć cytatu.
- Polityka `competency-test-rubric-v1`: below=0, meets=50, above=100, coverage = liczba ocen z dowodem / wszystkie kryteria, minimalny próg 0,60. Poniżej progu wynik liczbowy `null`, status `insufficient_evidence`. Od progu wynik 0–100 jest **pomocniczy**, status `review_required` — nigdy decyzja hire/reject. Wyniku nie wpisujemy do `screening_analysis_versions.overall_score`, ani do rankingu SC-008.
- Nie korzysta z AI, nie wykonuje wywołań zewnętrznych, nie zapisuje danych osobowych ani sekretów.

## Etap B — dalsza część SC-014 (niezrealizowana w tym PR)
1. Projekt i osobna nowa migracja tabeli prób z `company_id`, `recruitment_id`, `application_id`, `definition_entry_id`, stanem, czasem startu/końca wyznaczanym serwerowo oraz niezmienną odpowiedzią. Composite FK do applications i exercise_definition_entries.
2. Jednorazowy dostęp kandydata przydzielony przez zaufany backend na konkretny application/definition version; tylko hash sekretu, TTL, ograniczenia wielokrotnych prób, ochrony przed replayem, brak ujawnienia danych innych kandydatów. SC-010 dostarcza komunikację, ale nie stanowi autoryzacji samo w sobie.
3. Transactional RPC autoryzuje zarówno odczyt zadania, jak i zapis odpowiedzi; serwer wyznacza `submitted_at`, serializuje próby, nie ufa danym `company_id` ani czasowi z klienta. RLS/grants przeciw anon/outsider/viewer i direct DML; uwzględnia unieważnienie upoważnienia oraz brak ponownego otwarcia zakończonego testu.
4. Zapis wersjonowanej oceny przez rekrutera osobno od pracy kandydata; powiązanie z rubryką, dokładną odpowiedzią i recenzentem. Zmiana rubryki nie przelicza historii. Integracja z SC-015 dopiero po zaakceptowaniu read contract.
5. UI kandydata i przegląd rekrutera z czytelnymi stanami: nie rozpoczęto / rozpoczęto / wysłano / wygasło / do przeglądu / brak dowodów. Serwerowy timer, nie timer przeglądarki.

## Testy / bezpieczeństwo
Etap A: `npm run test:competency` i rozszerzone `npm run test:assessments`; sprawdzić `typecheck`, `build` i CI PR. Etap B: dwie firmy, różne role i kandydaci, przekroczony TTL, jednoczesne wysłanie, podwójne żądanie, nieprawidłowa wersja, usunięte członkostwo, SQL RLS, autoryzowane i nieautoryzowane GET/POST. Minimalizacja PII, retencja zgodna z procesem SC-010, brak produkcyjnej migracji bez osobnej zgody.

## Granice i stan
Ten PR **nie jest** gotowym flow dostępnym w Internecie. Nie tworzy publicznych tras, tabel, RPC, migracji, zaproszeń ani testów na prawdziwych kandydatach. Nie modyfikuje SC-008, SC-012/013, SC-015/016 ani Production. Niezależny L3 review i zielony CI są wymagane, następnie OWNER ACCEPTANCE przed merge do integration.
