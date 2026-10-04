import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePosition, behaviorAreas } from '../lib/position-fields.ts';
import { appOrigin, callbackDestination } from '../lib/auth-url.ts';

function completeForm() {
  const form = new FormData();
  for (const [key, value] of Object.entries({ title: ' Specjalista ', tasks: 'Obsługa klientów\r\n\r\n Raportowanie ', kpis: 'Czas odpowiedzi poniżej 24h', autonomy_level: '3', required_competencies: 'Komunikacja\nCRM' })) form.set(key, value);
  for (const [key] of behaviorAreas) form.set(key, 'Wysoki');
  return form;
}
test('interview retains tasks, KPI, autonomy and all eight behavior requirements', () => {
  const result = parsePosition(completeForm());
  assert.equal(result.title, 'Specjalista');
  assert.deepEqual(result.tasks, ['Obsługa klientów', 'Raportowanie']);
  assert.equal(result.autonomy_level, 3);
  assert.equal(result.required_behaviors.length, 8);
  assert.ok(result.required_behaviors.every(item => item.endsWith(': Wysoki')));
});
test('incomplete or tampered interview cannot be saved', () => {
  for (const [key,value] of [['title',' '],['tasks',''],['kpis',' '],['autonomy_level','3.5'],['autonomy_level','6'],['responsibility','Unknown'],['description','x'.repeat(10001)],['tasks','x'.repeat(501)]]) {
    const form = completeForm(); form.set(key,value);
    assert.throws(() => parsePosition(form));
  }
});
test('callback destinations are fixed and cannot redirect outside the app', () => {
  assert.equal(callbackDestination('recovery'), '/reset-password');
  for (const value of [null, 'https://evil.example', '//evil.example', '/admin']) assert.equal(callbackDestination(value), '/dashboard');
});
test('email callback origin rejects unsafe schemes and embedded credentials', () => {
  const previous = process.env.NEXT_PUBLIC_SITE_URL;
  try {
    for (const value of ['javascript:alert(1)', 'http://external.example', 'https://user:pass@example.com']) {
      process.env.NEXT_PUBLIC_SITE_URL = value; assert.throws(appOrigin);
    }
    process.env.NEXT_PUBLIC_SITE_URL = 'https://skillcheck.example/path';
    assert.equal(appOrigin(), 'https://skillcheck.example');
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous;
  }
});
