import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createBatchCloser} from '../lib/cv-bulk-close.ts';

const src = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/uploader.tsx', import.meta.url), 'utf8');

test('success is the only closed outcome', async () => {
  let calls = 0;
  const close = createBatchCloser(async () => { calls++; return {}; });
  assert.equal(await close(), 'closed');
  assert.equal(calls, 1);
});

test('{error}, empty response and thrown error are unconfirmed, never closed', async () => {
  assert.equal(await createBatchCloser(async () => ({error: 'Brak dostępu.'}))(), 'unconfirmed');
  assert.equal(await createBatchCloser(async () => { throw new Error('net'); })(), 'unconfirmed');
  assert.equal(await createBatchCloser(async () => undefined)(), 'closed', 'void action result carries no error');
});

test('retry repeats only the same close call; guard recovers after an error', async () => {
  let calls = 0;
  const close = createBatchCloser(async () => (++calls === 1 ? {error: 'x'} : {}));
  assert.equal(await close(), 'unconfirmed');
  assert.equal(await close(), 'closed');
  assert.equal(calls, 2);
});

test('double click while in flight sends one close', async () => {
  let calls = 0, release;
  const close = createBatchCloser(() => { calls++; return new Promise(r => { release = () => r({}); }); });
  const first = close();
  assert.equal(await close(), 'busy');
  release();
  assert.equal(await first, 'closed');
  assert.equal(calls, 1);
});

test('uploader: no redirect on unconfirmed close, retry never creates or re-uploads, link + aria-live kept', () => {
  assert.doesNotMatch(src, /finally\s*\{\s*router\.push/, 'unconditional redirect removed');
  const retry = src.slice(src.indexOf('async function closeBatch'), src.indexOf('if (unclosed)'));
  assert.doesNotMatch(retry, /createBulkBatch|fetch\(|randomUUID/, 'close retry touches nothing but close');
  assert.match(src, /if \(unclosed\) return <section aria-live="polite">/);
  assert.match(src, /<Link href=\{unclosed\.base\}>/);
  assert.match(src, /role="alert"/);
  assert.match(src, /disabled=\{closing\}/);
});
