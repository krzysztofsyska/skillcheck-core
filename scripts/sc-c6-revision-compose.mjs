import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(p,'utf8').replaceAll('\r\n','\n');
const extract=(text,name)=>{const start=text.indexOf('create function '+name+'('),end=text.indexOf('$$;',start);if(start<0||end<0)throw Error(name);return text.slice(start,end+3);};
const save=extract(read('supabase/migrations/20261002000300_exercise_definitions.sql'),'public.save_exercise_definition');
const approve=extract(read('db/components/exercise-ai-proposals.sql'),'exercise_ai.approve_proposal');
const hash=s=>createHash('sha256').update(s.split('$$')[1]).digest('hex');
const newSave=save.replace('create function','create or replace function')
 .replace('previous public.exercise_definition_entries%rowtype;','previous public.exercise_definition_entries%rowtype; source_proposal exercise_ai.proposals%rowtype;')
 .replace('  insert into public.exercise_definition_entries(',`  -- Use the same lock order as approval/rejection: parent, exercise, proposal.
  select * into source_proposal from exercise_ai.proposals where definition_entry_id=previous.id for update;
  insert into public.exercise_definition_entries(`)
 .replace('  return entry_id;',`  if source_proposal.id is not null then
    -- Editing cannot strip AI provenance or inherit an approval. This also
    -- covers the existing manual-save RPC, not just the new UI endpoint.
    insert into exercise_ai.proposals(company_id,recruitment_id,definition_entry_id,provenance,created_by)
      values(recruitment.company_id,recruitment.id,entry_id,
        (source_proposal.provenance - 'workflow' - 'human_edit') || jsonb_build_object('human_edit',jsonb_build_object(
          'source_definition_id',previous.id,'root_definition_id',coalesce(source_proposal.provenance->'human_edit'->>'root_definition_id',previous.id::text),
          'actor',actor,'at',clock_timestamp())),actor);
    if source_proposal.approved_at is null and coalesce(source_proposal.provenance->'workflow'->>'state','pending')='pending' then
      update exercise_ai.proposals set provenance=jsonb_set(provenance,'{workflow}',jsonb_build_object(
        'state','superseded','actor',actor,'at',clock_timestamp(),'next_definition_id',entry_id)) where id=source_proposal.id;
    end if;
  end if;
  return entry_id;`);
const newApprove=approve.replace('create function','create or replace function')
 .replace('  select * into proposal from exercise_ai.proposals p\n    where p.definition_entry_id = target_definition_entry and',`  perform pg_advisory_xact_lock(hashtextextended('exercise:' || (select e.exercise_id::text from public.exercise_definition_entries e where e.id=target_definition_entry),0));
  select * into proposal from exercise_ai.proposals p
    where p.definition_entry_id = target_definition_entry and`)
 .replace('  if proposal.approved_at is not null then return proposal.id; end if;',`  if proposal.approved_at is not null then return proposal.id; end if;
  if coalesce(proposal.provenance->'workflow'->>'state','pending') <> 'pending' then
    raise exception 'Proposal is no longer pending' using errcode='55000';
  end if;`);
const names=['public.edit_exercise_ai_proposal(uuid,uuid,uuid,timestamptz,jsonb,timestamptz)','public.reject_exercise_ai_proposal(uuid,uuid,uuid,timestamptz,text)'];
const signature='75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688';
const preflight=`do $preflight$ begin
 if private.erasure_schema_signature() is distinct from '${signature}' then raise exception 'c6_revision_requires_r14' using errcode='55000';end if;
 ${[[save,'public.save_exercise_definition(uuid,uuid,jsonb,integer,uuid,timestamptz)'],[approve,'exercise_ai.approve_proposal(uuid)']].map(([src,name])=>`if not exists(select 1 from pg_proc where oid='${name}'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${hash(src)}' and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'c6_revision_dependency_unreviewed:${name}' using errcode='55000';end if;`).join('\n ')}
end $preflight$;`;
const acl=`do $acl$ declare o record;g record;begin
 for o in select oid,proowner from pg_proc where oid=any(array[${names.map(n=>`'${n}'::regprocedure`).join(',')}]) loop
 execute format('revoke all on function %s from public',o.oid::regprocedure);
 for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where p.oid=o.oid and a.grantee<>o.proowner loop
 execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;end loop;end $acl$;
${names.map(n=>`alter function ${n} owner to postgres;\ngrant execute on function ${n} to authenticated;`).join('\n')}`;
writeFileSync('supabase/migrations/20261107164219_exercise_ai_revision_workflow.sql',`-- Generated from pinned reviewed functions by scripts/sc-c6-revision-compose.mjs.
-- Function-only change: no new storage, erasure inventory or runtime activation.
begin;\n${preflight}\n${newSave}\n${newApprove}\n${read('db/components/exercise-ai-revision-workflow.sql')}\n${acl}
do $postflight$ begin if private.erasure_schema_signature() is distinct from '${signature}' then raise exception 'c6_revision_inventory_changed' using errcode='55000';end if;end $postflight$;
commit;\n`);
// Rollback is deliberately blocked after any revised/rejected proposal exists:
// removing the lifecycle gate would make rejected proposals approvable again.
writeFileSync('supabase/rollbacks/20261107164219_exercise_ai_revision_workflow_down.sql',`begin;
do $$ begin if exists(select 1 from exercise_ai.proposals where provenance ? 'workflow' or provenance ? 'human_edit') then raise exception 'c6_revision_rollback_requires_forward_fix' using errcode='55000';end if;end $$;
${names.map(n=>`drop function ${n};`).join('\n')}
${save.replace('create function','create or replace function')}
${approve.replace('create function','create or replace function')}
commit;\n`);
