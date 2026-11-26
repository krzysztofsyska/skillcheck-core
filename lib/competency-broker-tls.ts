import { previewPoolTls } from './sc19-payment-preview-tls.ts';

/** Use the already reviewed Supabase roots only for Supabase-hosted databases:
 * the direct host `db.<ref>.supabase.co` and the Supavisor shared pooler
 * `aws-<n>-<region>.pooler.supabase.com`. Supabase documents verify-full with
 * this same root (prod-supabase.cer) against the pooler hosts, so no public CA
 * is added. Hostname verification and SNI remain pg/Node defaults. In
 * particular a connection-string query cannot replace these options: the
 * runtime rejects it. Disposable CI databases use the normal
 * system/NODE_EXTRA_CA_CERTS trust store.
 */
const SUPABASE_HOSTED = [
  /^db\.[a-z0-9]{20}\.supabase\.co$/,
  /^aws-[0-9]+-[a-z]{2}-[a-z]+-[0-9]+\.pooler\.supabase\.com$/
];
export function competencyGatewayTls(databaseUrl: string): {rejectUnauthorized:true;ca?:string} {
  const host=new URL(databaseUrl).hostname;
  return SUPABASE_HOSTED.some(pattern=>pattern.test(host))
    ? {rejectUnauthorized:true,ca:previewPoolTls.ca}
    : {rejectUnauthorized:true};
}
