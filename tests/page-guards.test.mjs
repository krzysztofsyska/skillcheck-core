import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every server page under these roots renders tenant or operator data and must
// call an access guard before doing anything else with the request.
const root = fileURLToPath(new URL('..', import.meta.url));
const GUARDED_ROOTS = ['app/dashboard', 'app/operator'];
const GUARD_CALL = /\bawait\s+(?:companyAccess|loadBehaviorContext|exerciseContext|loadScreeningReport|salesOperator|pricingOwner)\s*\(|\bawait\s+[\w.]+\.auth\.getUser\s*\(/;

function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name === 'page.tsx' ? [path] : [];
  });
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const files = GUARDED_ROOTS.flatMap((dir) => pages(join(root, dir)));

test('guarded roots contain pages', () => {
  assert.ok(files.length > 0, 'no page.tsx found under app/dashboard or app/operator');
});

for (const file of files) {
  const name = relative(root, file);
  test(`${name} calls an access guard`, () => {
    const source = stripComments(readFileSync(file, 'utf8'));
    assert.match(source, GUARD_CALL, `${name} must await companyAccess, loadBehaviorContext, exerciseContext, loadScreeningReport, salesOperator, pricingOwner or auth.getUser`);
  });
}
