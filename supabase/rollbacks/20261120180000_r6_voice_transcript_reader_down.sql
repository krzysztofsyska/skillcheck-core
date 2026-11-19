-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R6 #542 (odczyt transkryptu rozmowy głosowej dla rekrutera).
-- Usuwa funkcję public.read_voice_interview_transcripts i tabelę
-- report_audit.voice_transcript_reads. Transkrypty, schemat `report_audit` i inne
-- dzienniki zostają nietknięte.
--
-- Wpisy dziennika są w migracji NIEZMIENNE i są zapisem dostępu do danych kandydata.
-- Dlatego — wzorem 20261117120000_sc_ac_session_export_audit_down.sql — rollback
-- wykonuje się WYŁĄCZNIE, gdy tabela jest pusta. Usunięcie istniejących wpisów to
-- decyzja właściciela, nie rollback.
--
-- Migracja nie zmieniała relacji w 'public'/'private' (dodała tylko funkcję), więc
-- sygnatura inwentarza SC-010 ma pozostać ta sama.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi i nie zgłasza błędu.
-- Uruchamiaj przez `psql -v ON_ERROR_STOP=1` przy wstrzymanym ruchu aplikacji.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
  perform set_config('r6_voice_transcript_reader.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

-- Funkcja najpierw: po jej usunięciu nikt nie dopisze wpisu między sprawdzeniem a `drop table`.
drop function if exists public.read_voice_interview_transcripts(uuid, uuid, uuid);

do $guard$
begin
  if to_regclass('report_audit.voice_transcript_reads') is not null then
    lock table report_audit.voice_transcript_reads in access exclusive mode nowait;
    if exists (select 1 from report_audit.voice_transcript_reads) then
      raise exception 'r6_voice_transcript_reader_rollback_not_empty' using errcode = '55000';
    end if;
  end if;
end
$guard$;

drop table if exists report_audit.voice_transcript_reads;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('r6_voice_transcript_reader.signature_before', true) then
    raise exception 'r6_voice_transcript_reader_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regclass('report_audit.voice_transcript_reads') is not null
     or to_regprocedure('public.read_voice_interview_transcripts(uuid,uuid,uuid)') is not null then
    raise exception 'r6_voice_transcript_reader_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
