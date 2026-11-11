import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createProgressPoller, STALE_AFTER, FIRST_DELAY_MS, POLL_INTERVAL_MS} from '../lib/cv-bulk-poll.ts';

const src = readFileSync(new URL('../app/dashboard/[companyId]/recruitments/[recruitmentId]/bulk/[batchId]/progress.tsx', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const proc = n => ({batch: {status: 'processing'}, n});
const done = {batch: {status: 'completed'}};

function setup(reads) {
  const log = {data: [], stale: [], calls: 0};
  const poller = createProgressPoller({
    read: () => { log.calls++; const r = reads.shift(); return typeof r === 'function' ? r() : r instanceof Error ? Promise.reject(r) : Promise.resolve(r); },
    onData: d => log.data.push(d), onStale: s => log.stale.push(s), isCompleted: d => d.batch.status === 'completed',
  });
  return {poller, log};
}

test('null and rejection: stale only after 3 failures in a row, last data kept', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {poller, log} = setup([proc(1), null, new Error('x'), null, proc(2)]);
  poller.start();
  t.mock.timers.tick(FIRST_DELAY_MS); await flush();
  assert.deepEqual(log.data, [proc(1)]);
  for (let i = 0; i < STALE_AFTER - 1; i++) { t.mock.timers.tick(POLL_INTERVAL_MS); await flush(); }
  assert.deepEqual(log.stale, [], 'two failures are not enough');
  t.mock.timers.tick(POLL_INTERVAL_MS); await flush();
  assert.deepEqual(log.stale, [true]);
  assert.deepEqual(log.data, [proc(1)], 'failures never replace the last result');
  t.mock.timers.tick(POLL_INTERVAL_MS); await flush();
  assert.deepEqual(log.stale, [true, false], 'success clears the mark');
  assert.deepEqual(log.data, [proc(1), proc(2)]);
  poller.stop();
});

test('one request at a time: slow answer is not overlapped, manual retry is ignored meanwhile', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let release;
  const {poller, log} = setup([() => new Promise(r => { release = r; })]);
  poller.start();
  t.mock.timers.tick(FIRST_DELAY_MS); await flush();
  t.mock.timers.tick(POLL_INTERVAL_MS * 3); poller.retry(); await flush();
  assert.equal(log.calls, 1);
  release(proc(1)); await flush();
  assert.deepEqual(log.data, [proc(1)]);
  poller.stop();
});

test('manual retry reads immediately and recovers from stale', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {poller, log} = setup([null, null, null, proc(5)]);
  poller.start();
  t.mock.timers.tick(FIRST_DELAY_MS); await flush();
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(POLL_INTERVAL_MS); await flush(); }
  assert.deepEqual(log.stale, [true]);
  poller.retry(); await flush();
  assert.deepEqual(log.stale, [true, false]);
  assert.deepEqual(log.data, [proc(5)]);
  poller.stop();
});

test('completed stops polling; no further reads', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {poller, log} = setup([done, proc(9)]);
  poller.start();
  t.mock.timers.tick(FIRST_DELAY_MS); await flush();
  t.mock.timers.tick(POLL_INTERVAL_MS * 5); await flush();
  assert.equal(log.calls, 1);
  poller.retry(); await flush();
  assert.equal(log.calls, 1, 'retry after completion is a no-op');
});

test('stop (unmount / other batch) clears the timer and ignores the answer in flight', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let release;
  const a = setup([() => new Promise(r => { release = r; })]);
  a.poller.start();
  t.mock.timers.tick(FIRST_DELAY_MS); await flush();
  a.poller.stop();
  release(proc(1)); await flush();
  assert.deepEqual(a.log.data, []);
  const b = setup([proc(2)]);
  b.poller.start(); b.poller.stop();
  t.mock.timers.tick(FIRST_DELAY_MS * 10); await flush();
  assert.equal(b.log.calls, 0, 'stopped before the first tick: nothing fires');
});

test('progress page wiring: keyed by ids, poller cleanup, stale notice with retry, no completion when stale', () => {
  assert.match(src, /key=\{`\$\{props\.companyId\}:\$\{props\.recruitmentId\}:\$\{props\.batchId\}`\}/);
  assert.match(src, /return \(\) => \{ poller\.stop\(\)/);
  assert.match(src, /Nie udało się odświeżyć postępu/);
  assert.match(src, /pollerRef\.current\?\.retry\(\)/);
  assert.match(src, /stale && !finished/);
});
