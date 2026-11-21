/**
 * R6-1e: server composition of the Retell webhook runtime. Reached only after
 * retellWebhookGate (retell-webhook-config.ts) accepted the environment.
 *
 * Database: the webhook's own restricted login (role `retell_webhook`), never a
 * service key. One dedicated pooled connection per delivery: ingestRetellWebhook
 * runs its own transaction on it. A connection that failed mid-work is destroyed
 * instead of being returned to the pool, so an aborted transaction never leaks
 * into the next delivery. Nothing about the call, the key or the connection is
 * logged.
 */
import { Pool } from 'pg';
import { previewPoolTls } from '../sc19-payment-preview-tls.ts';
import type { SqlClient } from './trusted-source-verifier.ts';
import type { RetellWebhookRuntime } from './retell-webhook-http.ts';
import type { RetellWebhookDeployment } from './retell-webhook-config.ts';
import { RetellWebhookError } from './retell-webhook.ts';

type PooledClient = SqlClient & { release(destroy?: boolean | Error): void };
export type RetellWebhookPool = { connect(): Promise<PooledClient> };

let pool: Pool | undefined;
function sharedPool(databaseUrl: string): RetellWebhookPool {
  pool ??= new Pool({ connectionString: databaseUrl, ssl: previewPoolTls,
    max: 2, maxUses: 100, connectionTimeoutMillis: 6000, query_timeout: 12000,
    idleTimeoutMillis: 15000, allowExitOnIdle: true, options: '' }).on('error', () => {
      // pg discards a broken idle client. Do not log credentials or call data.
    });
  return pool as unknown as RetellWebhookPool;
}

export function composeRetellWebhookRuntime(
  config: RetellWebhookDeployment,
  deps: Readonly<{ pool?: RetellWebhookPool; now?: () => number }> = {},
): RetellWebhookRuntime {
  const database = deps.pool ?? sharedPool(config.databaseUrl);
  return Object.freeze({
    config: config.webhook,
    now: deps.now ?? (() => Date.now()),
    async withClient<T>(work: (db: SqlClient) => Promise<T>): Promise<T> {
      const client = await database.connect();
      let broken = false;
      try { return await work(client); }
      // A rejected delivery never opened a transaction; anything else may have.
      catch (error) { broken = !(error instanceof RetellWebhookError); throw error; }
      finally { client.release(broken); }
    },
  });
}
