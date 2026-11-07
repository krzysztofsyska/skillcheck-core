import { previewPoolTls } from './sc19-payment-preview-tls.ts';

/** Use the already reviewed Supabase roots only for direct hosted databases.
 * Hostname verification and SNI remain pg/Node defaults. In particular a
 * connection-string query cannot replace these options: the runtime rejects it.
 * Disposable CI databases use the normal system/NODE_EXTRA_CA_CERTS trust store.
 */
export function competencyGatewayTls(databaseUrl: string): {rejectUnauthorized:true;ca?:string} {
  const host=new URL(databaseUrl).hostname;
  return /^db\.[a-z0-9]{20}\.supabase\.co$/.test(host)
    ? {rejectUnauthorized:true,ca:previewPoolTls.ca}
    : {rejectUnauthorized:true};
}
