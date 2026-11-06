-- Wycofanie SC-014-C6 krok 2a. Odtwarza stan sprzed migracji: propozycji AI nie
-- było, zadania powstawały wyłącznie ręcznie przez public.save_exercise_definition
-- i tak dzieje się nadal, bo ta migracja tamtej ścieżki nie zmieniała.
--
-- Usuwa wyłącznie własne obiekty w schemacie `exercise_ai`. Ani ta migracja, ani
-- jej wycofanie nie dodaje i nie usuwa niczego w 'public' ani 'private' — także
-- żadnego więzu PRZYCHODZĄCEGO do tych schematów, bo tabele celowo nie mają
-- kluczy obcych poza własny schemat. Dlatego private.erasure_schema_signature()
-- i baseline inwentarza usuwania danych kandydata pozostają nietknięte w obie
-- strony, co pilnuje test w tests/exercise-ai-database.test.mjs.
begin;
drop function if exists exercise_ai.approve_proposal(uuid);
drop function if exists exercise_ai.record_proposal(uuid,uuid,jsonb,integer);
drop function if exists exercise_ai.set_auto_release(uuid,boolean);
drop function if exists exercise_ai.validate_provenance(jsonb);
drop table if exists exercise_ai.proposals;
drop table if exists exercise_ai.recruitment_settings;
drop schema if exists exercise_ai;
commit;
