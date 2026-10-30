import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Every protected page must call an access guard, either directly or through a
// relative-imported helper whose exported function itself calls one.
const guard = /\b(?:companyAccess|salesOperator|pricingOwner)\s*\(|\bauth\.getUser\s*\(/;

function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name === 'page.tsx' ? [path] : [];
  });
}

function moduleSource(from, specifier) {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try { return readFileSync(candidate, 'utf8'); } catch {}
  }
  return null;
}

function exportedFunctionBody(source, name) {
  const start = source.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function guardedViaHelper(file, source) {
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const names = match[1].split(',').map(part => part.trim()).filter(part => part && !part.startsWith('type '))
      .map(part => part.split(/\s+as\s+/).pop());
    const helper = moduleSource(file, match[2]);
    if (!helper) continue;
    for (const name of names) {
      if (!new RegExp(`\\b${name}\\s*\\(`).test(source)) continue;
      const body = exportedFunctionBody(helper, name);
      if (body && guard.test(body)) return true;
    }
  }
  return false;
}

test('every dashboard and operator page calls an access guard', () => {
  const files = [...pages('app/dashboard'), ...pages('app/operator')];
  assert.ok(files.length > 0, 'found protected pages');
  const unguarded = files.filter(file => {
    const source = readFileSync(file, 'utf8');
    return !guard.test(source) && !guardedViaHelper(file, source);
  });
  assert.deepEqual(unguarded, [], 'pages without an access guard');
});
