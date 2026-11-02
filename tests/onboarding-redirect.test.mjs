import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import * as validation from '../lib/auth-validation.ts';
import * as authUrl from '../lib/auth-url.ts';
import * as legal from '../lib/legal.ts';

// Loads app/auth/actions.ts with mocked Next.js and Supabase modules.
function load(rpcResult) {
  const path = new URL('../app/auth/actions.ts', import.meta.url).pathname;
  const mod = new Module(path); mod.filename = path;
  mod.paths = Module._nodeModulePaths(new URL('../', import.meta.url).pathname);
  const require = createRequire(path);
  const client = { auth: { async getUser() { return { data: { user: { id: 'u1' } } }; } }, async rpc() { return rpcResult; } };
  const mocks = {
    'next/navigation': { redirect(url) { const e = new Error('REDIRECT'); e.url = url; throw e; } },
    'next/headers': { async headers() { return new Map(); } },
    '../../lib/supabase/server': { async createClient() { return client; } },
    '../../lib/auth-validation': validation, '../../lib/auth-url': authUrl, '../../lib/legal': legal,
  };
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path);
  return mod.exports;
}
async function target(rpcResult, name = 'Firma') {
  const form = new FormData(); form.set('name', name);
  try { await load(rpcResult).createCompany(form); } catch (e) { if (e.url) return e.url; throw e; }
  return null;
}
const id = '6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

test('after creating a company the user lands on that company, not the list', async () => {
  assert.equal(await target({ data: id, error: null }), `/dashboard/${id}`);
});
test('an unexpected RPC value falls back to the company list; errors stay on onboarding', async () => {
  for (const data of [null, '', '../operator', `${id}/x`, 42]) assert.equal(await target({ data, error: null }), '/dashboard');
  assert.equal(await target({ data: null, error: { message: 'x' } }), '/onboarding?message=failed');
  assert.equal(await target({ data: id, error: null }, '   '), '/onboarding?message=invalid');
});
