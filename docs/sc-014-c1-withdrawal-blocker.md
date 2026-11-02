# SC-014-C1, slice 3/4 — dlaczego protokół wycofania nie został przeniesiony

**Data:** 2026-11-02 · **Status:** ZATRZYMANE, wymaga przepisania zamiast przeniesienia

## Co się stało

Slice 1/4 i 2/4 przeniosły się z `db/isolated/` niemal jeden do jednego. Slice 3/4
(`db/isolated/sc014-b2-withdrawal.sql`) **nie może** — i gdyby został przeniesiony bez zmian,
osłabiłby bezpieczeństwo działającego kodu.

Plik zawiera `create or replace function public.confirm_erasure_subject(...)`, czyli **zastępuje
funkcję, która już działa na produkcji**. Prototyp był pisany na podstawie starszej wersji tej
funkcji. Porównanie z aktualną wersją z łańcucha migracji
(`supabase/migrations/20261010204840_erasure_execution_protocol.sql:464`) pokazuje, że wersja
z prototypu **nie zawiera trzech kontroli**, które dziś w niej są:

1. **Blokada wiersza firmy** `for update nowait` razem z `private.erasure_owner(tenant)`.
   Aktualna wersja blokuje wiersz właściciela do COMMIT; prototyp sprawdza tożsamość właściciela
   tylko przez `exists`, bez blokady.
2. **Sprawdzenie zamrożenia kandydatów z nowej listy** —
   `if exists(... where private.erasure_candidate_frozen(s.id)) then ... 'Candidate workflow frozen'`.
   W prototypie go nie ma.
3. **Sprawdzenie zamrożenia kandydatów z poprzedniego rozstrzygnięcia zakresu.** Aktualna wersja
   ma przy tym komentarz wyjaśniający, po co to jest: *usunięcie zamrożonego członka z nowej listy
   nie może obejść jego istniejącego powiązania*. W prototypie go nie ma.

## Czego prototyp jednak nie gubi

Dla uczciwości: `private.competency_lock_resolution` przejmuje część tego, co znikło z samej
funkcji — sprawdza tożsamość właściciela, przynależność każdego kandydata do firmy, blokuje
kandydatów przez `erasure_lock_candidate`, sprawdza `restore_isolated` i woła
`competency_authority(tenant,true)`. **Nie przejmuje natomiast żadnej z dwóch kontroli zamrożenia.**

## Dlaczego to jest poważne

`confirm_erasure_subject` jest funkcją `security definer` w protokole usuwania danych osobowych.
Kontrole zamrożenia istnieją po to, żeby nie dało się zmienić zakresu osoby w trakcie trwającej
operacji usuwania. Przeniesienie prototypu bez zmian usunęłoby je po cichu — nic by się nie
wywróciło, testy slice'ów 1 i 2 nadal by przechodziły, a zabezpieczenie zniknęłoby.

## Co trzeba zrobić zamiast tego

Nie portować. **Wyprowadzić nową wersję `confirm_erasure_subject` z wersji aktualnej**, dokładając
do niej wyłącznie wywołanie `private.competency_lock_resolution(tenant,ids)` w miejscu zgodnym
z kolejnością blokad z SC-014-B1 sekcja 4, i zachowując wszystkie istniejące kontrole.

Reszta pliku (`competency_marker_guard`, `competency_write_markers`,
`competency_resolution_closure`, `competency_lock_resolution`, `competency_revoke_applications`,
`competency_resolution_insert_guard`, `withdraw_competency_test_access`) to nowe obiekty
i przenosi się normalnie.

Wymagany test, bez którego slice 3/4 nie jest gotowy: próba zmiany zakresu osoby, gdy którykolwiek
kandydat — z nowej listy albo z poprzedniego rozstrzygnięcia — jest zamrożony, musi nadal kończyć
się `PT409 Candidate workflow frozen`. Dopiero to dowodzi, że zastąpienie funkcji niczego nie cofnęło.

## Wniosek ogólny

To już druga rzecz w SC-014-C1, która wynika z tego, że prototypy powstały miesiąc temu:
najpierw inwentarz usuwania przypięty do bazy r5 (slice 4/4), teraz ta funkcja. Przy każdym
`create or replace` w tych plikach trzeba najpierw porównać z wersją aktualną, a nie zakładać,
że prototyp jest nowszy.
