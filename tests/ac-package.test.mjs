import test from 'node:test';
import assert from 'node:assert/strict';
import { AC_PACKAGE_ENTITLEMENT, acPackageState } from '../lib/assessment-center-package.ts';

// ROADMAP R3: the page-side reading of the company's entitlements. The database enforces the
// package (tests/ac-package-gate-database.test.mjs); this only decides what the page says.
test('AC package state: active only with a paid ASSESSMENT CENTER package, unknown on a bad answer', () => {
  assert.equal(AC_PACKAGE_ENTITLEMENT, 'package:ASSESSMENT_CENTER');
  assert.equal(acPackageState([{ code: 'package:ASSESSMENT_CENTER', available: 1, used: 0 }]), 'active');
  assert.equal(acPackageState([{ code: 'skill_test', available: 5, used: 0 }, { code: 'package:ASSESSMENT_CENTER', available: 3, used: 2 }]), 'active');
  assert.equal(acPackageState([]), 'missing');
  assert.equal(acPackageState([{ code: 'package:ASSESSMENT_CENTER', available: 0, used: 1 }]), 'missing');
  assert.equal(acPackageState([{ code: 'package:WERYFIKACJA', available: 1, used: 0 }]), 'missing');
  for (const bad of [null, undefined, {}, 'x', [{ code: 'package:ASSESSMENT_CENTER', available: -1, used: 0 }], [{ code: '', available: 1, used: 0 }]]) {
    assert.equal(acPackageState(bad), 'unknown', JSON.stringify(bad));
  }
});
