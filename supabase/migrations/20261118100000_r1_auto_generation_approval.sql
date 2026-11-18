-- R1-AUTO-GEN-FIX — zadanie wygenerowane z ekranu rekrutacji respektuje wybrany tryb
-- (docs/ROADMAP.md, R1; uwaga bota Codex w PR #504).
--
-- Do tej pory public.finish_exercise_ai_generation (20261107171053) zapisywało każdą
-- propozycję AI bez zatwierdzenia, także gdy rekruter wybrał „Automatycznie". Takie
-- zadanie nie było zwolnione, więc automatyczne wydanie dostępu
-- (public.issue_exercise_ai_auto_access, 20261117220000) je pomijało.
--
-- Zmiana: jedna funkcja, `create or replace`, ta sama sygnatura. Jedyna różnica w treści:
-- przy zapisie propozycji czyta tryb z wiersza ustawień rekrutacji (zablokowanego FOR UPDATE
-- wcześniej w tej samej funkcji) i w trybie automatycznym zapisuje
-- approved_by = zalogowana osoba, approved_at = now(), approval_mode = 'auto' — dokładnie tak
-- jak exercise_ai.record_proposal. Tryb ręczny (brak wiersza albo auto_release = false)
-- działa jak dotąd: propozycja czeka na zatwierdzenie człowieka.
--  * Tryb nie przychodzi od klienta, tylko z bazy (jak w record_proposal).
--  * Rekrutacja musi być otwarta/szkic, stanowisko niezarchiwizowane, a definicja poprawna:
--    te warunki funkcja sprawdza już przed zapisem (inaczej błąd), więc automat nie zwalnia
--    zadania w zamkniętej rekrutacji.
--  * Reguła R1 (krótka lista) zostaje w bazie bez zmian: zatwierdzenie zadania nie wydaje
--    dostępu nikomu; dostęp wydaje wyłącznie issue_exercise_ai_auto_access /
--    create_competency_test_grant przez private.competency_eligible.
--  * security definer, search_path = '', właściciel i uprawnienia (tylko authenticated) bez
--    zmian — `create or replace` je zachowuje, a postflight to sprawdza.
--  * NICZEGO NIE WYSYŁA (żadnego e-maila ani SMS-a). Brak nowych relacji: sygnatura SC-010
--    (private.erasure_schema_signature) ma zostać ta sama.
begin;

do $preflight$
begin
  if not exists (select 1 from pg_proc
      where oid = to_regprocedure('public.finish_exercise_ai_generation(uuid,uuid,uuid,text,jsonb,jsonb,text)')
        and encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') = '24c057459b50e8931ef8592c5a90321ab1403e3552d464de742f0981cd5fb57f'
        and pg_get_userbyid(proowner) = 'postgres' and prosecdef and proconfig = array['search_path=""']
        and proacl::text = '{postgres=X/postgres,authenticated=X/postgres}') then
    raise exception 'r1_auto_gen_dependency_unreviewed:public.finish_exercise_ai_generation' using errcode = '55000';
  end if;
  if to_regclass('exercise_ai.recruitment_settings') is null or to_regclass('exercise_ai.proposals') is null
     or to_regprocedure('private.erasure_schema_signature()') is null then
    raise exception 'r1_auto_gen_dependency_missing' using errcode = '55000';
  end if;
  perform set_config('r1_auto_gen.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create or replace function public.finish_exercise_ai_generation(target_company uuid,target_recruitment uuid,request_key uuid,
 input_fingerprint text,new_definition jsonb,new_provenance jsonb,error_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.recruitments;p public.positions;c public.company_profiles;s exercise_ai.recruitment_settings;
 item jsonb;entry_id uuid;exercise_id uuid:=gen_random_uuid();trace jsonb;actor uuid:=auth.uid();is_auto boolean;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Read committed required' using errcode='PT409';end if;
 perform private.competency_authority(target_company);
 select * into r from public.recruitments where id=target_recruitment and company_id=target_company for share;
 if not found then raise exception 'Resource unavailable' using errcode='PT404';end if;
 select * into p from public.positions where id=r.position_id and company_id=target_company for share;
 select * into c from public.company_profiles where company_id=target_company for share;
 perform pg_advisory_xact_lock(hashtextextended('exercise_ai:'||r.id::text,0));
 select * into s from exercise_ai.recruitment_settings where company_id=target_company and recruitment_id=r.id for update;
 item:=s.generation_requests->request_key::text;
 if item is null or item->>'actor' is distinct from auth.uid()::text or item->>'fingerprint' is distinct from input_fingerprint then
  raise exception 'Request unavailable' using errcode='PT404';end if;
 if item->>'status'<>'reserved' then return item;end if;
 if (item->>'expires_at')::timestamptz<clock_timestamp() then error_code:='exercise_ai_timeout';end if;
 if error_code is not null then
  if error_code not in ('exercise_ai_refusal','exercise_ai_invalid_output','exercise_ai_timeout','exercise_ai_rate_limit','exercise_ai_auth_error','exercise_ai_server_error','exercise_ai_network_error') then
   raise exception 'Invalid failure' using errcode='22023';end if;
  item:=item||jsonb_build_object('status','failed','error',error_code);
 else
  if r.status not in ('draft','open') or p.id is null or p.status='archived' or p.id::text is distinct from item->>'position_id'
    or p.updated_at is distinct from (item->>'position_updated_at')::timestamptz or c.updated_at is distinct from (item->>'company_updated_at')::timestamptz then
   raise exception 'Profile changed' using errcode='PT409';end if;
  trace:=exercise_ai.validate_provenance(new_provenance);
  if trace->>'input_fingerprint' is distinct from input_fingerprint or trace->>'position_id' is distinct from p.id::text
    or (trace->>'position_updated_at')::timestamptz is distinct from p.updated_at then raise exception 'Origin changed' using errcode='22023';end if;
  perform private.competency_validate_definition(new_definition);
  entry_id:=public.save_exercise_definition(r.id,exercise_id,new_definition,0,p.id,p.updated_at);
  -- R1 (owner 2026-11-16): the recruiter's per-recruitment choice decides. The mode is read HERE,
  -- in this transaction, from the settings row locked FOR UPDATE above, never taken from the caller.
  -- No row or auto_release = false means manual approval. The recruitment is open and the position
  -- live at this point (checked above), the same conditions exercise_ai.record_proposal requires
  -- before it auto-approves; the definition was validated above.
  is_auto:=coalesce(s.auto_release,false);
  insert into exercise_ai.proposals(company_id,recruitment_id,definition_entry_id,provenance,created_by,
    approved_by,approved_at,approval_mode)
   values(target_company,r.id,entry_id,trace,actor,
    case when is_auto then actor end,case when is_auto then now() end,case when is_auto then 'auto' end);
  item:=item||jsonb_build_object('status','completed','definition_id',entry_id,'exercise_id',exercise_id);
 end if;
 update exercise_ai.recruitment_settings set generation_requests=jsonb_set(generation_requests,array[request_key::text],item) where company_id=target_company and recruitment_id=r.id;
 return item;
end;$$;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('r1_auto_gen.signature_before', true) then
    raise exception 'r1_auto_gen_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc
      where oid = 'public.finish_exercise_ai_generation(uuid,uuid,uuid,text,jsonb,jsonb,text)'::regprocedure
        and encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') = 'e1d1ad6cca52e1e54aa11eed72449c377b3e7baa62f6de3a884cc3ef8230488a'
        and pg_get_userbyid(proowner) = 'postgres' and prosecdef and proconfig = array['search_path=""']
        and proacl::text = '{postgres=X/postgres,authenticated=X/postgres}') then
    raise exception 'r1_auto_gen_function_mismatch' using errcode = '55000';
  end if;
end
$postflight$;
commit;
