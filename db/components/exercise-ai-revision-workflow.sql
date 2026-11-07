-- Server-owned lifecycle metadata is added beside the original provider trace.
-- The provider fields are never rewritten and callers cannot write this JSON.
create function public.reject_exercise_ai_proposal(target_company uuid,target_recruitment uuid,target_definition uuid,
 expected_position_updated_at timestamptz,rejection_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare review jsonb; entry public.exercise_definition_entries%rowtype; proposal exercise_ai.proposals%rowtype;
begin
 review:=public.read_exercise_ai_proposal(target_company,target_recruitment,target_definition);
 if expected_position_updated_at is null or expected_position_updated_at is distinct from
  (review->'definitionEntry'->>'position_updated_at')::timestamptz then
  raise exception 'Proposal context changed' using errcode='PT409';end if;
 if rejection_reason is null or length(btrim(rejection_reason)) not between 1 and 1000 then
  raise exception 'Invalid rejection reason' using errcode='22023';end if;
 perform 1 from public.recruitments r join public.positions p on p.company_id=r.company_id and p.id=r.position_id
  where r.company_id=target_company and r.id=target_recruitment and r.status in ('draft','open') and p.status<>'archived' for share of r,p;
 if not found then raise exception 'Editing closed' using errcode='55000';end if;
 select * into entry from public.exercise_definition_entries where id=target_definition for share;
 perform pg_advisory_xact_lock(hashtextextended('exercise:'||entry.exercise_id::text,0));
 select * into proposal from exercise_ai.proposals where definition_entry_id=target_definition for update;
 if not found then raise exception 'Resource unavailable' using errcode='PT404';end if;
 if proposal.approved_at is not null then raise exception 'Approved revision is immutable' using errcode='55000';end if;
 if proposal.provenance->'workflow'->>'state'='rejected' then return proposal.id;end if;
 if proposal.provenance->'workflow'->>'state'='superseded' or exists(
  select 1 from public.exercise_definition_entries e where e.exercise_id=entry.exercise_id and e.version>entry.version) then
  raise exception 'Proposal context changed' using errcode='PT409';end if;
 update exercise_ai.proposals set provenance=jsonb_set(provenance,'{workflow}',jsonb_build_object(
  'state','rejected','actor',auth.uid(),'at',clock_timestamp(),'reason',btrim(rejection_reason))) where id=proposal.id;
 return proposal.id;
end;$$;

create function public.edit_exercise_ai_proposal(target_company uuid,target_recruitment uuid,target_definition uuid,
 expected_position_updated_at timestamptz,new_definition jsonb,expected_current_position_updated_at timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare review jsonb; entry public.exercise_definition_entries%rowtype;
begin
 review:=public.read_exercise_ai_proposal(target_company,target_recruitment,target_definition);
 if expected_position_updated_at is null or expected_position_updated_at is distinct from
  (review->'definitionEntry'->>'position_updated_at')::timestamptz then
  raise exception 'Proposal context changed' using errcode='PT409';end if;
 select * into entry from public.exercise_definition_entries where id=target_definition;
 -- save_exercise_definition takes the parent locks and exercise advisory lock,
 -- checks the latest version, and copies provenance atomically with the insert.
 -- Every new human revision is pending, even if auto_release is enabled.
 return public.save_exercise_definition(target_recruitment,entry.exercise_id,new_definition,
  entry.version,entry.position_id,expected_current_position_updated_at);
end;$$;
