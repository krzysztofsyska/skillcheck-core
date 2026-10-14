import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  sc19AnalysisScope,
  sc19OfferScopes,
  sc19PackageSizesFromRows,
  sc19PolicyPendingCell,
  sc19PolicyPendingScope,
} from '../lib/sc19-package-sizes.ts';

test('package size copy follows the canonical policy rows', () => {
  assert.equal(sc19AnalysisScope(3), '3 analiz CV');
  assert.equal(sc19AnalysisScope(12), '12 analiz CV');
  assert.throws(() => sc19AnalysisScope(0), /Nie można odczytać wielkości pakietów/);
  assert.throws(() => sc19AnalysisScope(1.5), /Nie można odczytać wielkości pakietów/);
  assert.deepEqual(sc19PackageSizesFromRows([
    { plan: 'PRESELEKCJA', credits: 12 },
    { plan: 'FREE', credits: 3 },
    { plan: 'OTHER', credits: 99 },
  ]), { FREE: 3, PRESELEKCJA: 12 });
  assert.throws(() => sc19PackageSizesFromRows([{ plan: 'FREE', credits: 3 }]), /Nie można odczytać wielkości pakietów/);
  assert.throws(() => sc19PackageSizesFromRows([
    { plan: 'FREE', credits: 3 },
    { plan: 'FREE', credits: 4 },
    { plan: 'PRESELEKCJA', credits: 12 },
  ]), /Nie można odczytać wielkości pakietów/);
  const pending = sc19OfferScopes(null);
  assert.equal(pending.freeScope, sc19PolicyPendingScope);
  assert.equal(pending.preselectionScope, sc19PolicyPendingScope);
  assert.equal(pending.freeAnalyses, sc19PolicyPendingCell);
  assert.equal(pending.preselectionAnalyses, sc19PolicyPendingCell);
  assert.equal(JSON.stringify(pending).includes('60'), false);
  assert.equal(JSON.stringify(pending).includes('5'), false);
  const live = sc19OfferScopes({ FREE: 3, PRESELEKCJA: 12 });
  assert.equal(live.freeScope, '3 analiz CV');
  assert.equal(live.preselectionScope, '12 analiz CV');
  assert.equal(live.freeAnalyses, '3');
  assert.equal(live.preselectionAnalyses, '12');
});

test('customer-facing package copy does not hardcode grant amounts', async () => {
  const billing = await readFile(new URL('../app/dashboard/[companyId]/billing/page.tsx', import.meta.url), 'utf8');
  const marketing = await readFile(new URL('../app/components/marketing/package-comparison.tsx', import.meta.url), 'utf8');
  const handoff = await readFile(new URL('../docs/sc-019-mvp-a1-handoff.md', import.meta.url), 'utf8');
  const sql = await readFile(new URL('../docs/prototypes/sc-019-mvp-credits.sql', import.meta.url), 'utf8');
  assert.match(billing, /loadSc19PackageSizes/);
  assert.match(billing, /sc19AnalysisScope\(sizes\.FREE\)/);
  assert.match(billing, /sc19AnalysisScope\(sizes\.PRESELEKCJA\)/);
  assert.doesNotMatch(billing, /5 analiz CV|60 analiz CV/);
  assert.doesNotMatch(marketing, /5 analiz CV|60 analiz CV|5–6/);
  assert.match(marketing, /sc19OfferScopes/);
  assert.match(handoff, /sc19_package_sizes/);
  assert.match(handoff, /touch_updated_at/);
  assert.doesNotMatch(handoff, /exactly 60|FREE \(5 analyses\)/);
  assert.match(sql, /execute function private\.touch_updated_at\(\)/);
  assert.match(sql, /create function public\.sc19_package_sizes\(\)/);
  assert.doesNotMatch(sql, /sc19_list_credit_history|sc19_list_offers/);
});
