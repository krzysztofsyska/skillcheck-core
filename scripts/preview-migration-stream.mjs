// Preview workflow transport only. Migration text never enters argv or env.
// The workflow owns project/allowlist/resync authorization; this helper emits
// one SQL stream with the existing atomic migration + ledger transaction.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

const [mode, path, ...extra] = process.argv.slice(2);
if (!['hash', 'apply', 'resync'].includes(mode) || !path || extra.length) throw Error('Expected hash|apply|resync and a migration path');
const file = basename(path);
const match = /^([0-9]{14})_([a-z0-9_]+)\.sql$/.exec(file);
if (!match) throw Error('Invalid migration filename');
const bytes = readFileSync(path);
// Match Bash $(cat file) exactly: remove LF bytes only, including repeated LF.
// Do not normalize internal CRLF, strip CR, trim spaces or normalize Unicode.
let end = bytes.length;
while (end > 0 && bytes[end - 1] === 0x0a) end--;
const canonical = bytes.subarray(0, end);
if (mode === 'hash') {
  process.stdout.write(createHash('sha256').update(canonical).digest('hex') + '\n');
} else {
  // The alphabet contains no SQL quotes, backslashes, dollar tags or psql
  // metacommands. PostgreSQL decodes the value from stdin, never from a file.
  const body = `pg_catalog.convert_from(pg_catalog.decode('${canonical.toString('base64')}', 'base64'), 'UTF8')`;
  const [, version, name] = match; // Filename allowlist makes these SQL literals safe.
  let sql;
  if (mode === 'resync') {
    sql = `update supabase_migrations.schema_migrations set statements = array[${body}]\n` +
      `  where version = (select max(version) from supabase_migrations.schema_migrations where name = '${name}');\n`;
  } else {
    // Validate the entire input before emitting anything. These are the same
    // top-level begin/last-commit constraints enforced by the workflow.
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n');
    const whitespace = /^[ \t\r\f\v]*$/;
    const begins = lines.filter(line => /^begin;[ \t\r\f\v]*$/.test(line));
    const commits = lines.flatMap((line, index) => /^commit;[ \t\r\f\v]*$/.test(line) ? [index] : []);
    const last = lines.findLastIndex(line => !whitespace.test(line));
    if (begins.length !== 1 || commits.length !== 1 || commits[0] !== last) throw Error('Migration must have one top-level begin and end with its only commit');
    lines.splice(commits[0], 1);
    sql = lines.join('\n') + '\n' +
      `insert into supabase_migrations.schema_migrations(version, name, statements) values ('${version}', '${name}', array[${body}]);\ncommit;\n`;
  }
  process.stdout.write(sql);
}
