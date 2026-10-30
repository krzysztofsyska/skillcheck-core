import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Supabase bundles the Edge Function with Deno, which rejects bare specifiers
// ("zod") that are not mapped. Walk the worker's import graph the way Deno does
// and require every bare specifier to be mapped in the function's deno.json.
const entry = resolve('supabase/functions/screening-worker/index.ts');
const config = JSON.parse(readFileSync(resolve('supabase/functions/screening-worker/deno.json'), 'utf8'));
const importPattern = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function graph() {
  const seen = new Set(), bare = new Map(), queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(importPattern)) {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        const path = [target, `${target}.ts`].find(existsSync);
        assert.ok(path, `${specifier} imported by ${file} does not exist`);
        if (path.endsWith('.ts')) queue.push(path);
      } else if (!/^(npm|node|jsr|https?):/.test(specifier)) {
        bare.set(specifier, file);
      }
    }
  }
  return { seen, bare };
}

test('every bare import reachable from the screening worker is mapped for Deno', () => {
  const { seen, bare } = graph();
  assert.ok(seen.size > 3, 'the worker graph includes lib modules');
  assert.ok(bare.has('zod'), 'the evidence schema (zod) is part of the worker graph');
  for (const [specifier, file] of bare) {
    assert.ok(Object.hasOwn(config.imports ?? {}, specifier), `"${specifier}" (from ${file}) needs an entry in supabase/functions/screening-worker/deno.json`);
  }
});

test('the Deno mapping pins the same zod version as package-lock.json', () => {
  const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
  assert.equal(config.imports.zod, `npm:zod@${lock.packages['node_modules/zod'].version}`);
});
