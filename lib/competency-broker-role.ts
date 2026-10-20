/**
 * SC-014-B3: on every acquired connection, verify the effective privileges
 * of BOTH the exact session LOGIN and the eventual SET LOCAL ROLE gateway.
 *
 * Catalog checks cover all non-system schemas, relations, sequences, and
 * callable functions, including invoker functions. PUBLIC grants count too.
 * Neither identity may own objects or receive explicit system-object ACLs.
 * No cache: grants can be changed while a Node pool remains alive.
 */
import type { CompetencyConnection } from './competency-attempt-transport.ts';

// Only these six B2 entry points are callable after SET LOCAL ROLE. Match
// exact overloads, not function names, owner, or SECURITY DEFINER alone.
// Resolve identities through catalogs: LOGIN intentionally lacks private USAGE,
// so resolving a private name through regprocedure input can itself be denied.
const GATEWAY_FUNCTIONS = [
  'private.exchange_candidate_competency_test_session(text)',
  'private.inspect_candidate_competency_test(bytea)',
  'private.start_candidate_competency_test(bytea,uuid)',
  'private.save_candidate_competency_test_draft(bytea,text,bigint,uuid)',
  'private.submit_candidate_competency_test(bytea,jsonb,uuid)',
  'private.status_candidate_competency_test(bytea)'
];
const PRIVILEGE_AUDIT = `
with allowed_functions as (
  select p.oid from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where pg_catalog.format('%I.%I(%s)',n.nspname,p.proname,
    replace(pg_catalog.oidvectortypes(p.proargtypes),', ',','))=any($1::text[])
), system_acl as (
  select a.grantee from pg_catalog.pg_parameter_acl p,
    lateral pg_catalog.aclexplode(p.paracl) a
  union all
  select a.grantee from pg_catalog.pg_namespace n,
    lateral pg_catalog.aclexplode(n.nspacl) a
    where n.nspname ~ '^(pg_|information_schema$)'
  union all
  select a.grantee from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace,
    lateral pg_catalog.aclexplode(c.relacl) a
    where n.nspname ~ '^(pg_|information_schema$)'
  union all
  select a.grantee from pg_catalog.pg_attribute att
    join pg_catalog.pg_class c on c.oid=att.attrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace,
    lateral pg_catalog.aclexplode(att.attacl) a
    where n.nspname ~ '^(pg_|information_schema$)'
  union all
  select a.grantee from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace,
    lateral pg_catalog.aclexplode(p.proacl) a
    where n.nspname ~ '^(pg_|information_schema$)'
)

select r.rolname as role_name, r.rolname=session_user as is_login,
 r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
 r.rolreplication, r.rolbypassrls, r.rolinherit,
 -- Ownership survives REVOKE and lets an owner grant itself privileges again.
 -- Shared dependencies cover every ownable object type, including other DBs.
 (select count(*)::int from pg_catalog.pg_shdepend d
   where d.refclassid='pg_catalog.pg_authid'::regclass
     and d.refobjid=r.oid and d.deptype='o') as owned_objects,
 (select count(*)::int from system_acl a where a.grantee=r.oid) as system_grants,
 (select count(*)::int from pg_auth_members m where m.member=r.oid) as memberships,
 (select count(*)::int from pg_auth_members m join pg_roles parent on parent.oid=m.roleid
  where m.member=r.oid and parent.rolname='competency_test_gateway'
    and m.set_option and not m.inherit_option and not m.admin_option) as gateway_memberships,
 (select count(*)::int from pg_namespace n
  where n.nspname !~ '^(pg_|information_schema$)'
   and (has_schema_privilege(r.oid,n.oid,'CREATE,USAGE WITH GRANT OPTION')
    or (has_schema_privilege(r.oid,n.oid,'USAGE')
      and n.nspname <> 'public'
      and not (r.rolname='competency_test_gateway' and n.nspname='private')))) as forbidden_schemas,
 (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname !~ '^(pg_|information_schema$)' and c.relkind in ('r','p','v','m','f')
   and (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) as forbidden_relations,
 (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname !~ '^(pg_|information_schema$)'
   and case when c.relkind='S' then
     has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE') else false end) as forbidden_sequences,
 (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname !~ '^(pg_|information_schema$)'
    and has_schema_privilege(r.oid,n.oid,'USAGE')
    and has_function_privilege(r.oid,p.oid,'EXECUTE')
    and (has_function_privilege(r.oid,p.oid,'EXECUTE WITH GRANT OPTION')
      or not (r.rolname='competency_test_gateway'
        and p.oid in (select oid from allowed_functions)))) as forbidden_functions,
 (select count(*)::int from allowed_functions f
  where f.oid is not null and has_function_privilege(r.oid,f.oid,'EXECUTE')) as allowed_functions,
 has_schema_privilege(r.oid,'private','USAGE') as private_usage,
 has_database_privilege(r.oid,current_database(),'CREATE') as database_create
from pg_roles r where r.rolname=session_user or r.rolname='competency_test_gateway'
`;

const LOGGING_AUDIT = [
  "select current_setting('log_statement') as statements,",
  " current_setting('log_parameter_max_length') as success_parameters,",
  " current_setting('log_parameter_max_length_on_error') as error_parameters,",
  " current_setting('pgaudit.log_parameter',true) as pgaudit_parameters,",
  " current_setting('auto_explain.log_min_duration',true) as auto_explain_duration"
].join('\n');

export async function verifyCompetencyGateway(
  client: CompetencyConnection,
  expectedUser: string
): Promise<void> {
  if (!/^competency_gateway_[a-z0-9_]{1,40}$/.test(expectedUser)) {
    throw new Error('Gateway login not approved');
  }
  const identities = (await client.query(PRIVILEGE_AUDIT, [GATEWAY_FUNCTIONS])).rows;
  if (identities.length !== 2) throw new Error('Unsafe gateway identity');
  for (const identity of identities) {
    const login = identity.is_login === true;
    if (identity.role_name !== (login ? expectedUser : 'competency_test_gateway') ||
        identity.rolcanlogin !== login || identity.rolsuper || identity.rolcreatedb ||
        identity.rolcreaterole || identity.rolreplication || identity.rolbypassrls ||
        identity.rolinherit || identity.owned_objects !== 0 || identity.system_grants !== 0 ||
        identity.memberships !== (login ? 1 : 0) ||
        identity.gateway_memberships !== (login ? 1 : 0) ||
        identity.forbidden_schemas !== 0 || identity.forbidden_relations !== 0 ||
        identity.forbidden_sequences !== 0 || identity.forbidden_functions !== 0 ||
        identity.allowed_functions !== (login ? 0 : GATEWAY_FUNCTIONS.length) ||
        identity.private_usage !== !login || identity.database_create) {
      throw new Error('Unsafe gateway privileges');
    }
  }

  // PostgreSQL duration/statement/error logging can independently log bind
  // parameters. Defaults (-1) are unsafe even when log_statement is "none".
  // Audit extensions have separate logging controls; unknown configurations
  // fail closed until explicitly reviewed. A restricted login cannot inspect
  // superuser-only shared_preload_libraries (and must not gain pg_read_all_settings),
  // so deployment needs a separate privileged configuration attestation.
  const logging = (await client.query(LOGGING_AUDIT)).rows[0];
  if (!logging ||
      logging.statements !== 'none' ||
      logging.success_parameters !== '0' ||
      logging.error_parameters !== '0' ||
      (logging.pgaudit_parameters != null && logging.pgaudit_parameters !== 'off') ||
      (logging.auto_explain_duration != null && logging.auto_explain_duration !== '-1')) {
    throw new Error('Unsafe database parameter logging');
  }
}
