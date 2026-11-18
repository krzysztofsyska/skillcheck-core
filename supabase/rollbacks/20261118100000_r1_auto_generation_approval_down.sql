-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R1-AUTO-GEN-FIX: przywraca treść public.finish_exercise_ai_generation z
-- 20261107171053 (propozycja z generowania zawsze czeka na zatwierdzenie człowieka).
-- Propozycje już zatwierdzone automatycznie zostają (nic nie jest kasowane); rekruter
-- odwołuje wydane dostępy istniejącą funkcją C3. Relacje bez zmian, sygnatura SC-010 ta sama.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
  perform set_config('r1_auto_gen.signature_before', private.erasure_schema_signature(), true);
end
$preflight$;

create or replace function public.finish_exercise_ai_generation(target_company uuid,target_recruitment uuid,request_key uuid,
 input_fingerprint text,new_definition jsonb,new_provenance jsonb,error_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.recruitments;p public.positions;c public.company_profiles;s exercise_ai.recruitment_settings;
 item jsonb;entry_id uuid;exercise_id uuid:=gen_random_uuid();trace jsonb;
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
  -- Generation always needs a human approval, even with a legacy auto setting.
  insert into exercise_ai.proposals(company_id,recruitment_id,definition_entry_id,provenance,created_by)
   values(target_company,r.id,entry_id,trace,auth.uid());
  item:=item||jsonb_build_object('status','completed','definition_id',entry_id,'exercise_id',exercise_id);
 end if;
 update exercise_ai.recruitment_settings set generation_requests=jsonb_set(generation_requests,array[request_key::text],item) where company_id=target_company and recruitment_id=r.id;
 return item;
end;$$;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from current_setting('r1_auto_gen.signature_before', true) then
    raise exception 'r1_auto_gen_rollback_inventory_changed' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_proc
      where oid = 'public.finish_exercise_ai_generation(uuid,uuid,uuid,text,jsonb,jsonb,text)'::regprocedure
        and encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') = '24c057459b50e8931ef8592c5a90321ab1403e3552d464de742f0981cd5fb57f'
        and proacl::text = '{postgres=X/postgres,authenticated=X/postgres}') then
    raise exception 'r1_auto_gen_rollback_function_mismatch' using errcode = '55000';
  end if;
end
$postflight$;
commit;
