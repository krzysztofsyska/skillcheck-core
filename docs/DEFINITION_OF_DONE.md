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
- branch zgodny z konwencją i utworzony z `integration` dla nowych tasków,
- PR opisuje zakres, testy, migracje i ryzyka,
- reviewer PASS i CI PASS,
- OWNER ACCEPTANCE zapisane przed merge tasku do `integration`,
- bezpośredni merge task branch do `main` jest zabroniony.

## Produkcja
Jeśli task obejmuje wdrożenie:
- osobny promotion PR `integration -> main`,
- PRODUCTION APPROVAL właściciela zapisane przed merge/deploy,
- deploy success,
- migracje/functions/secrets wykonane wyłącznie w zatwierdzonym runbooku,
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
