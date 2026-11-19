-- R6 (#542) — odczyt transkryptu zakończonej rozmowy głosowej dla rekrutera.
--
-- Transkrypty (20261120120000_r6_voice_transcripts_r23.sql) leżą w
-- `private.sc011b_voice_transcripts`, zamkniętej dla ról API. Ta migracja dodaje
-- jedyną drogę odczytu: `public.read_voice_interview_transcripts(...)` dla jednego
-- zgłoszenia, wyłącznie do odczytu. Ekran, który z niej korzysta, działa tylko na
-- Preview (voicePlanPreviewEnabled(), zawsze wyłączone przy VERCEL_ENV=production).
--
-- Kontrola dostępu liczona w bazie (ta sama co eksport raportu SC-015-D i sesji AC):
--  * zalogowany właściciel firmy albo rekruter (private.has_company_access(..., true));
--    czytelnik nie widzi strony scenariusza rozmowy, więc nie czyta transkryptu;
--  * zgłoszenie istnieje pod tą firmą i tą rekrutacją;
--  * dane kandydata nie są zamrożone ani w trakcie usuwania
--    (private.candidate_workflow_visible) i zgłoszenie nie jest wycofane.
-- Obca firma, obca rekrutacja i nieistniejące zgłoszenie dają ten sam błąd 42501;
-- wycofane zgłoszenie albo zamrożone dane kandydata — 55000.
--
-- Co zwraca (tylko rozmowy ze statusem 'completed' tego zgłoszenia, w kolejności):
--  * call_no — numer rozmowy w tym zgłoszeniu (1, 2, ...), bez identyfikatorów
--    dostawcy, połączenia ani próby;
--  * call_at — kiedy rozmowa została zlecona;
--  * transcript_state — 'available' | 'erased_retention' | 'not_received';
--  * utterances — tylko przy 'available': [{speaker, text}] przepisane pole po polu,
--    nic więcej z wiersza nie wychodzi.
-- Retencja (decyzja właściciela 2026-10-30): 90 dni po zamknięciu rekrutacji. Gdy
-- termin minął, transkrypt NIE jest pokazywany, nawet jeśli zadanie czyszczące
-- jeszcze go nie usunęło — odczyt zwraca 'erased_retention'.
--
-- Dziennik dostępu: każdy udany odczyt dopisuje wiersz do
-- `report_audit.voice_transcript_reads` (kto, w jakiej roli, kiedy, której firmy /
-- rekrutacji / zgłoszenia, ile transkryptów pokazano). Bez treści rozmowy i bez
-- danych kandydata. Ten sam zamknięty schemat i te same wyzwalacze niezmienności co
-- SC-015-D (report_audit.guard_entry / guard_truncate).
--
-- Sygnatura SC-010: nowa tabela jest poza 'public'/'private', w 'public' dochodzi tylko
-- funkcja. Preflight zapamiętuje sygnaturę, postflight wymaga, żeby była identyczna.
begin;

do $preflight$
begin
  if to_regclass('report_audit.voice_transcript_reads') is not null
     or to_regprocedure('public.read_voice_interview_transcripts(uuid,uuid,uuid)') is not null then
    raise exception 'r6_voice_transcript_reader_already_installed' using errcode = '55000';
  end if;
  if to_regnamespace('report_audit') is null
     or to_regprocedure('report_audit.guard_entry()') is null
     or to_regprocedure('report_audit.guard_truncate()') is null
     or to_regclass('private.sc011b_voice_transcripts') is null
     or to_regclass('private.sc011b_voice_attempts') is null
     or to_regclass('private.sc010c_voice_preparations') is null
     or to_regclass('public.applications') is null or to_regclass('public.recruitments') is null
     or to_regprocedure('private.has_company_access(uuid,boolean)') is null
     or to_regprocedure('private.is_company_owner(uuid)') is null
     or to_regprocedure('private.candidate_workflow_visible(uuid,uuid)') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'r6_voice_transcript_reader_dependency_missing' using errcode = '55000';
  end if;
  perform set_config('r6_voice_transcript_reader.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create table report_audit.voice_transcript_reads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  application_id uuid not null,
  actor_id uuid not null,
  actor_role text not null check (actor_role in ('owner', 'recruiter')),
  transcripts_shown integer not null check (transcripts_shown between 0 and 1000),
  created_at timestamptz not null default clock_timestamp()
);
create index voice_transcript_reads_application
  on report_audit.voice_transcript_reads (company_id, application_id, created_at);

alter table report_audit.voice_transcript_reads enable row level security;
revoke all on report_audit.voice_transcript_reads from public;
do $revoke$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on report_audit.voice_transcript_reads from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on report_audit.voice_transcript_reads from authenticated;
  end if;
end
$revoke$;

create trigger guard_entries before update or delete on report_audit.voice_transcript_reads
  for each row execute function report_audit.guard_entry();
create trigger guard_truncate before truncate on report_audit.voice_transcript_reads
  for each statement execute function report_audit.guard_truncate();

create function public.read_voice_interview_transcripts(
  target_company uuid,
  target_recruitment uuid,
  target_application uuid
) returns table (
  call_no integer, call_at timestamptz, transcript_state text, utterances jsonb
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  subject uuid;
  application_status text;
  retention_expired boolean;
  shown integer;
begin
  if actor is null or target_company is null or target_recruitment is null or target_application is null
     or not private.has_company_access(target_company, true) then
    raise exception 'voice_transcript_forbidden' using errcode = '42501';
  end if;
  select a.candidate_id, a.status,
         (r.status = 'closed' and r.closed_at is not null
          and r.closed_at <= pg_catalog.clock_timestamp() - interval '90 days')
    into subject, application_status, retention_expired
    from public.applications a
    join public.recruitments r on r.id = a.recruitment_id and r.company_id = a.company_id
   where a.company_id = target_company and a.recruitment_id = target_recruitment and a.id = target_application;
  if not found then
    raise exception 'voice_transcript_forbidden' using errcode = '42501';
  end if;
  if not private.candidate_workflow_visible(target_company, subject) or application_status = 'withdrawn' then
    raise exception 'voice_transcript_withdrawn' using errcode = '55000';
  end if;

  select count(*)::integer into shown
    from private.sc011b_voice_attempts va
    join private.sc010c_voice_preparations p on p.company_id = va.company_id and p.id = va.preparation_id
    join private.sc011b_voice_transcripts t on t.company_id = va.company_id and t.attempt_id = va.id
   where va.company_id = target_company and va.status = 'completed'
     and p.recruitment_id = target_recruitment and p.application_id = target_application
     and not retention_expired;

  insert into report_audit.voice_transcript_reads
    (company_id, recruitment_id, application_id, actor_id, actor_role, transcripts_shown)
  values (target_company, target_recruitment, target_application, actor,
          case when private.is_company_owner(target_company) then 'owner' else 'recruiter' end, shown);

  return query
    select (row_number() over (order by va.created_at, va.id))::integer,
           va.created_at,
           case when retention_expired then 'erased_retention'
                when t.attempt_id is null then 'not_received'
                else 'available' end,
           case when retention_expired or t.attempt_id is null then null
                else (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                               'speaker', u.value ->> 'speaker', 'text', u.value ->> 'text') order by u.pos)
                        from pg_catalog.jsonb_array_elements(t.utterances) with ordinality u(value, pos)) end
      from private.sc011b_voice_attempts va
      join private.sc010c_voice_preparations p on p.company_id = va.company_id and p.id = va.preparation_id
      left join private.sc011b_voice_transcripts t on t.company_id = va.company_id and t.attempt_id = va.id
     where va.company_id = target_company and va.status = 'completed'
       and p.recruitment_id = target_recruitment and p.application_id = target_application
     order by va.created_at, va.id;
end;
$$;

do $grants$
declare fn text := 'public.read_voice_interview_transcripts(uuid,uuid,uuid)';
begin
  execute format('revoke all on function %s from public', fn);
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on function %s from anon', fn);
  end if;
  if exists (select 1 from pg_roles where rolname = 'screening_worker') then
    execute format('revoke all on function %s from screening_worker', fn);
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('revoke all on function %s from service_role', fn);
  end if;
  execute format('grant execute on function %s to authenticated', fn);
end
$grants$;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('r6_voice_transcript_reader.signature_before', true) then
    raise exception 'r6_voice_transcript_reader_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'report_audit' and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'r6_voice_transcript_reader_rls_missing' using errcode = '55000';
  end if;
  if exists (select 1 from pg_constraint k
              join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
              join pg_class f on f.oid = k.confrelid join pg_namespace fn on fn.oid = f.relnamespace
             where n.nspname = 'report_audit' and fn.nspname <> 'report_audit') then
    raise exception 'r6_voice_transcript_reader_foreign_key_outside_schema' using errcode = '55000';
  end if;
  if exists (select 1 from pg_roles r where r.rolname in ('anon', 'authenticated')
              and has_schema_privilege(r.oid, 'report_audit', 'USAGE')) then
    raise exception 'r6_voice_transcript_reader_schema_exposed' using errcode = '55000';
  end if;
  -- Tabela transkryptów zostaje zamknięta dla ról API; jedyną drogą jest funkcja powyżej.
  if exists (select 1 from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
              and has_table_privilege(r.oid, 'private.sc011b_voice_transcripts', 'select,insert,update,delete')) then
    raise exception 'r6_voice_transcript_reader_transcripts_exposed' using errcode = '55000';
  end if;
end
$postflight$;

commit;
