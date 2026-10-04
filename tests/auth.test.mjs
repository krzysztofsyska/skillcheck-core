import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentials } from '../lib/auth-validation.ts';

const form = (email, password) => {
  const data = new FormData();
  if (email !== undefined) data.set('email', email);
  if (password !== undefined) data.set('password', password);
  return data;
};
test('credentials preserve passwords verbatim and trim email only', () => {
  assert.deepEqual(credentials(form('  person@example.com ', ' pass word ')), { email: 'person@example.com', password: ' pass word ' });
});
test('reject malformed or missing credentials and oversized input', () => {
  for (const input of [form(), form('person@example.com'), form('person@example.com', ''), form('person@', 'secret'), form('person @example.com', 'secret'), form('x'.repeat(255) + '@example.com', 'secret'), form('person@example.com', 'x'.repeat(257))]) {
    assert.equal(credentials(input), null);
  }
});
