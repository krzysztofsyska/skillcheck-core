// SC-OPS-DB-MIGRATE inspect: read-only snapshot of the schema shape that
// migration preflights compare (SC-019 catalog fingerprints and the SC-010
// erasure signature) plus the recorded migration history. Runs in a READ ONLY
// transaction that is always rolled back; reads no application rows.
// Output: a JSON report (for the workflow artifact) and a short summary of
// which reviewed fixture states each fingerprint matches.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { tlsOptions, withoutTlsParameters } from './apply.mjs';

const manifestUrl = new URL('../../tests/fixtures/sc19-migration-manifest.json', import.meta.url);

export async function inspect({ databaseUrl, ssl, log = console.log }) {
  const contract = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const client = new pg.Client({ connectionString: ssl ? withoutTlsParameters(databaseUrl) : databaseUrl, ssl, application_name: 'skillcheck-db-inspect' });
  await client.connect();
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    await client.query("set local search_path=''; set local timezone='UTC'; set local datestyle='ISO, YMD'; set local statement_timeout='60s'");
    const server = (await client.query("select version() version, current_setting('server_version_num')::int number")).rows[0];
    const major = Math.floor(server.number / 10000);
    const catalog = {};
    for (const [name, sql] of Object.entries(contract.queries)) {
      const row = (await client.query(sql)).rows[0];
      catalog[name] = { digest: row.digest, object_count: row.object_count, manifest: row.manifest };
    }
    const signature = (await client.query("select to_regprocedure('private.erasure_schema_signature()') is not null present")).rows[0].present
      ? (await client.query('select private.erasure_schema_signature() value')).rows[0].value : null;
    const history = (await client.query(`select version, name, statements from supabase_migrations.schema_migrations order by version`)).rows;
    const baselines = (await client.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='private' and c.relname ~ '^erasure_inventory_baseline_r[0-9]+$' order by 1`)).rows.map(row => row.relname);
    await client.query('rollback');

    const observed = { sc010_signature: signature, ...Object.fromEntries(Object.entries(catalog).map(([k, v]) => [k, v.digest])) };
    const matches = {};
    for (const [state, entry] of Object.entries(contract.states)) {
      const expected = { ...entry.pg16, ...(major === 17 ? entry.pg17 : {}) };
      matches[state] = Object.fromEntries(Object.keys(observed).map(key => [key, expected[key] === observed[key]]));
    }
    log(`server ${server.version}`);
    log(`erasure inventory baselines: ${baselines.join(', ') || 'none'}`);
    log(`recorded migrations: ${history.length}`);
    for (const [state, keys] of Object.entries(matches)) {
      const differing = Object.entries(keys).filter(([, same]) => !same).map(([key]) => key);
      log(`${state}: ${differing.length ? `differs in ${differing.join(', ')}` : 'MATCH'}`);
    }
    return { server, observed, matches, baselines, catalog, history };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL secret missing in the production-approval environment');
  const report = await inspect({ databaseUrl: process.env.DATABASE_URL, ssl: tlsOptions(process.env.DATABASE_CA_CERT) });
  await writeFile(process.argv[2] ?? 'inspection.json', JSON.stringify(report, null, 1));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(`::error::${error.message}`); process.exit(1); });
}
