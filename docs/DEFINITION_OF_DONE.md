# SkillCheck — Definition of Done

Task jest DONE wyłącznie gdy spełnia wszystkie wymagane punkty.

## Kod
- zakres tasku wykonany,
- brak nieuzgodnionych funkcji pobocznych,
- brak sekretów,
- brak martwego/debug kodu.

## Dane i bezpieczeństwo
- tenant isolation zachowana,
- RLS nieosłabione,
- migracje są nowe i jednokrotne; wykonanych migracji nie ponawiano,
- uprawnienia owner/recruiter/viewer zgodne z taskiem,
- dane kandydata i CV nie są ujawniane poza wymagany zakres.

## Jakość
- typecheck PASS,
- build PASS,
- testy modułu PASS,
- wymagane testy regresji PASS,
- dla L2/L3 review Codex zakończone PASS lub poprawki wdrożone i ponownie sprawdzone.

## Produkt
- acceptance criteria spełnione,
- błędy mają czytelne komunikaty,
- brak fałszywego UI sugerującego działającą funkcję, jeśli integracja nie istnieje.

## Git
- branch zgodny z konwencją,
- PR opisuje zakres, testy, migracje i ryzyka,
- merge dopiero po READY TO MERGE.

## Produkcja
Jeśli task obejmuje wdrożenie:
- deploy success,
- smoke test PASS,
- dokumentacja stanu produkcji zaktualizowana.

## AI
Jeśli task używa AI:
- wejście jest minimalne i zatwierdzone,
- prompt injection z CV jest traktowany jako dane, nie instrukcje,
- limity kosztu/żądań istnieją,
- wynik jest wersjonowany i powiązany z fingerprintem wejścia,
- człowiek może sprawdzić dowody,
- brak automatycznej finalnej decyzji o zatrudnieniu.
