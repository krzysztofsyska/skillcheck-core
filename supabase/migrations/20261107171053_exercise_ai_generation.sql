-- Durable call reservations, bounded by the existing recruitment ceiling.
-- No new identity/FK lifecycle: metadata is erased with recruitment settings.
begin;
do $$ begin if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
 raise exception 'c6_generation_requires_r15' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r15 where singleton and schema_signature='1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44') then
  raise exception 'c6_generation_requires_reviewed_r15' using errcode='55000';end if;end $$;
alter table exercise_ai.recruitment_settings add column generation_requests jsonb not null default '{}'::jsonb
 check(jsonb_typeof(generation_requests)='object' and octet_length(generation_requests::text)<=1000000);

create function public.reserve_exercise_ai_generation(target_company uuid,target_recruitment uuid,request_key uuid,
 expected_position_updated_at timestamptz,expected_company_updated_at timestamptz,input_fingerprint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.recruitments;p public.positions;c public.company_profiles;s exercise_ai.recruitment_settings;
 item jsonb;used integer;actor uuid:=auth.uid();
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Read committed required' using errcode='PT409';end if;
 perform private.competency_authority(target_company);
 if request_key is null or input_fingerprint is null or input_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'Invalid request' using errcode='22023';end if;
 select * into r from public.recruitments where id=target_recruitment and company_id=target_company for share;
 if not found then raise exception 'Resource unavailable' using errcode='PT404';end if;
 select * into p from public.positions where id=r.position_id and company_id=target_company for share;
 if not found or r.status not in ('draft','open') or p.status='archived' then raise exception 'Generation closed' using errcode='55000';end if;
 select * into c from public.company_profiles where company_id=target_company for share;
 if p.updated_at is distinct from expected_position_updated_at or c.updated_at is distinct from expected_company_updated_at then
  raise exception 'Profile changed' using errcode='PT409';end if;
 perform pg_advisory_xact_lock(hashtextextended('exercise_ai:'||r.id::text,0));
 insert into exercise_ai.recruitment_settings(company_id,recruitment_id,set_by) values(target_company,r.id,actor) on conflict do nothing;
 select * into s from exercise_ai.recruitment_settings where company_id=target_company and recruitment_id=r.id for update;
 item:=s.generation_requests->request_key::text;
 if item is not null then
  if item->>'actor'<>actor::text or item->>'fingerprint'<>input_fingerprint or (item->>'position_updated_at')::timestamptz is distinct from p.updated_at
    or (item->>'company_updated_at')::timestamptz is distinct from c.updated_at then raise exception 'Request changed' using errcode='PT409';end if;
  if item->>'status'='reserved' and (item->>'expires_at')::timestamptz<clock_timestamp() then
   item:=item||jsonb_build_object('status','failed','error','exercise_ai_timeout');
   update exercise_ai.recruitment_settings set generation_requests=jsonb_set(generation_requests,array[request_key::text],item) where company_id=target_company and recruitment_id=r.id;
  end if;
  return item||jsonb_build_object('claimed',false);
 end if;
 select count(*) into used from exercise_ai.proposals where recruitment_id=r.id and company_id=target_company and not(provenance?'human_edit');
 -- Completed requests already have a proposal counted above; failed/crashed calls
 -- remain consumed because the provider may have billed them. Never refund/retry.
 used:=used+(select count(*) from jsonb_each(s.generation_requests) q where q.value->>'status'<>'completed');
 if used>=least(s.draft_ceiling,20) then raise exception 'Draft limit reached' using errcode='PT429';end if;
 item:=jsonb_build_object('actor',actor,'fingerprint',input_fingerprint,'position_id',p.id,'position_updated_at',p.updated_at,
  'company_updated_at',c.updated_at,'status','reserved','created_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '120 seconds');
 update exercise_ai.recruitment_settings set generation_requests=jsonb_set(generation_requests,array[request_key::text],item) where company_id=target_company and recruitment_id=r.id;
 return item||jsonb_build_object('claimed',true);
end;$$;

create function public.finish_exercise_ai_generation(target_company uuid,target_recruitment uuid,request_key uuid,
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

do $acl$ declare o record;g record;begin
 for o in select oid,proowner from pg_proc where oid=any(array[
  'public.reserve_exercise_ai_generation(uuid,uuid,uuid,timestamptz,timestamptz,text)'::regprocedure,
  'public.finish_exercise_ai_generation(uuid,uuid,uuid,text,jsonb,jsonb,text)'::regprocedure]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where p.oid=o.oid and a.grantee<>o.proowner loop
   execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
  execute format('grant execute on function %s to authenticated',o.oid::regprocedure);
 end loop;
end $acl$;
do $$ begin if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
 raise exception 'c6_generation_inventory_changed' using errcode='55000';end if;end $$;
commit;
