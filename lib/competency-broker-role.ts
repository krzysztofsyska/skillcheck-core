/**
 * SC-014-B3: on every acquired connection, verify the effective privileges
 * of the exact session LOGIN, not only the set-local gateway role.
 *
 * Catalog checks cover all non-system schemas, relations, sequences, and
 * privileged functions. A positive grant from PUBLIC or another role counts.
 * No cache: grants can be changed while a Node pool remains alive.
 */
import type { CompetencyConnection } from './competency-attempt-transport.ts';

const PRIVILEGE_AUDIT = [
  'select r.rolname as login, r.rolcanlogin, r.rolsuper, r.rolcreatedb,',
  ' r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolinherit,',
  " pg_has_role(session_user,'competency_test_gateway','member') as member,",
  ' (select count(*)::int from pg_auth_members m where m.member=r.oid) as memberships,',
  ' (select count(*)::int from pg_auth_members m',
  "  where m.member=r.oid and m.roleid=(select oid from pg_roles where rolname='competency_test_gateway')) as gateway_memberships,",
  ' (select count(*)::int from pg_auth_members m',
  "  where m.member=(select oid from pg_roles where rolname='competency_test_gateway')) as inherited_gateway_memberships,",
  ' (select count(*)::int from pg_namespace n',
  "  where n.nspname !~ '^(pg_|information_schema$)'",
  '   and (has_schema_privilege(session_user,n.oid,\'CREATE\')',
  "    or (n.nspname not in ('public','extensions') and has_schema_privilege(session_user,n.oid,'USAGE')))) as forbidden_schemas,",
  ' (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace',
  "  where n.nspname !~ '^(pg_|information_schema$)' and c.relkind in ('r','p','v','m','f')",
  '   and (has_table_privilege(session_user,c.oid,\'SELECT\')',
  '    or has_table_privilege(session_user,c.oid,\'INSERT\')',
  '    or has_table_privilege(session_user,c.oid,\'UPDATE\')',
  '    or has_table_privilege(session_user,c.oid,\'DELETE\')',
  '    or has_table_privilege(session_user,c.oid,\'TRUNCATE\')',
  '    or has_table_privilege(session_user,c.oid,\'REFERENCES\')',
  '    or has_table_privilege(session_user,c.oid,\'TRIGGER\'))) as forbidden_relations,',
  ' (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace',
  "  where n.nspname !~ '^(pg_|information_schema$)' and c.relkind='S'",
  '   and (has_sequence_privilege(session_user,c.oid,\'SELECT\')',
  '    or has_sequence_privilege(session_user,c.oid,\'USAGE\')',
  '    or has_sequence_privilege(session_user,c.oid,\'UPDATE\'))) as forbidden_sequences,',
  ' (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace',
  "  where n.nspname !~ '^(pg_|information_schema$)'",
  "    and has_schema_privilege(session_user,n.oid,'USAGE')",
  "    and has_function_privilege(session_user,p.oid,'EXECUTE')",
  "    and (p.prosecdef or exists (select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a",
  "            where a.grantee=r.oid and a.privilege_type='EXECUTE'))) as forbidden_functions,",
  " has_database_privilege(session_user,current_database(),'CREATE') as database_create",
  ' from pg_roles r where r.rolname=session_user'
].join('\n');

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
  const identity = (await client.query(PRIVILEGE_AUDIT)).rows[0];
  if (!identity ||
      identity.login !== expectedUser ||
      !identity.rolcanlogin || identity.rolsuper || identity.rolcreatedb ||
      identity.rolcreaterole || identity.rolreplication ||
      identity.rolbypassrls || identity.rolinherit ||
      !identity.member || identity.memberships !== 1 ||
      identity.gateway_memberships !== 1 ||
      identity.inherited_gateway_memberships !== 0 ||
      identity.forbidden_schemas !== 0 ||
      identity.forbidden_relations !== 0 ||
      identity.forbidden_sequences !== 0 ||
      identity.forbidden_functions !== 0 ||
      identity.database_create) {
    throw new Error('Unsafe gateway privileges');
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
