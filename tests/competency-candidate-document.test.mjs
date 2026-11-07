import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { candidateDocument } from '../lib/competency-candidate-document.ts';

test('candidate can open an invitation, start, save and submit one attempt', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {});
    return nodes.get(id);
  };
  const requests = [];
  const token = 'a'.repeat(64);
  let ready;
  let cleaned;
  const replies = {
    bootstrap: { csrf: 'preflight' }, exchange: { csrf: 'session' },
    inspect: { state: 'not_started', durationMinutes: 15 },
    start: { state: 'in_progress', deadlineAt: new Date(Date.now() + 900000).toISOString(),
      test: { title: 'Diagnoza', instructions: 'Ustal przyczynę', expectedOutput: 'Plan' },
      draft: { text: 'Pierwsza hipoteza', version: 2 } },
    save: { version: 3 }, submit: { state: 'submitted' },
  };
  const html = candidateDocument('a'.repeat(24));
  vm.runInNewContext(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1], {
    location: { hash: '#grant=' + token, pathname: '/zadanie-kompetencyjne' },
    history: { replaceState: (_, __, path) => { cleaned = path; } },
    document: { getElementById: get, addEventListener: (_, fn) => { ready = fn; } },
    crypto: { randomUUID: () => 'request-id' },
    fetch: async (url, init) => {
      assert.equal(cleaned, '/zadanie-kompetencyjne');
      assert.equal(url, '/api/competency/attempt');
      const body = JSON.parse(init.body);
      requests.push(body);
      return { ok: true, json: async () => replies[body.operation] };
    },
  });
  ready();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('start').hidden, false);
  await get('begin').onclick();
  assert.equal(get('answer').value, 'Pierwsza hipoteza');
  get('answer').value = 'Odpowiedź';
  await get('save').onclick();
  await get('submit').onclick();
  assert.deepEqual(requests.map(row => row.operation), ['bootstrap','exchange','inspect','start','save','submit']);
  assert.equal(requests[1].token, token);
  assert.equal(requests[4].expectedVersion, 2);
  assert.equal(requests[5].answer.workSample, 'Odpowiedź');
  assert.equal(get('receipt').hidden, false);
  assert.equal(get('answer').value, '');
});


test('uncertain save or submit preserves a selectable copy and never retries the mutation', async () => {
  for (const operation of ['save', 'submit']) {
    const nodes = new Map();
    const get = id => {
      if (!nodes.has(id)) nodes.set(id, {});
      return nodes.get(id);
    };
    const requests = [];
    let ready;
    const html = candidateDocument('b'.repeat(24));
    vm.runInNewContext(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1], {
      location: { hash: '', pathname: '/zadanie-kompetencyjne' },
      history: { replaceState() {} },
      document: { getElementById: get, addEventListener: (_, fn) => { ready = fn; } },
      crypto: { randomUUID: () => 'unique-request' },
      fetch: async (_, init) => {
        const body = JSON.parse(init.body);
        requests.push(body.operation);
        if (body.operation === operation) return { ok: false, status: 503 };
        const values = {
          bootstrap: { csrf: 'session' },
          inspect: { state: 'not_started', durationMinutes: 15 },
          start: {
            state: 'in_progress', deadlineAt: new Date(Date.now() + 900000).toISOString(),
            test: { title: 'Diagnoza', instructions: 'Ustal przyczynę', expectedOutput: 'Plan' },
            draft: { text: '', version: 1 },
          },
        };
        return { ok: true, json: async () => values[body.operation] };
      },
    });
    ready();
    await new Promise(resolve => setImmediate(resolve));
    await get('begin').onclick();
    get('answer').value = 'Odpowiedź przygotowana przed awarią.';
    await get(operation).onclick();
    assert.equal(get('answer').value, 'Odpowiedź przygotowana przed awarią.');
    assert.equal(get('recovery').hidden, false);
    assert.equal(get('recovery-text').value, 'Odpowiedź przygotowana przed awarią.');
    assert.equal(get('controls').disabled, true);
    assert.equal(requests.filter(value => value === operation).length, 1);
    assert.match(get('message').textContent, /Zachowaj treść i odśwież stronę/);
  }
});
