import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exerciseRecruitmentMatches, exercisePositionMatches } from '../lib/exercise-context-identity.ts';

const companyId = 'abcdef01-1111-4111-8111-111111111111';
const recruitmentId = 'abcdef02-2222-4222-8222-222222222222';
const positionId = 'abcdef03-3333-4333-8333-333333333333';
const otherId = 'abcdef04-4444-4444-8444-444444444444';
const recruitment = () => ({ id: recruitmentId, company_id: companyId, position_id: positionId });
const position = () => ({ id: positionId, company_id: companyId });

test('SC-014/016 exercise context accepts only same-company recruitment and position', () => {
  assert.equal(exerciseRecruitmentMatches(recruitment(), companyId, recruitmentId), true);
  assert.equal(exercisePositionMatches(position(), companyId, positionId), true);
  // PostgreSQL UUID equality is case-insensitive; the fixture has actual hex letters.
  assert.notEqual(recruitmentId.toUpperCase(), recruitmentId);
  assert.equal(exerciseRecruitmentMatches({
    ...recruitment(), id: recruitmentId.toUpperCase(), company_id: companyId.toUpperCase(),
    position_id: positionId.toUpperCase(),
  }, companyId, recruitmentId), true);
  assert.equal(exercisePositionMatches({
    ...position(), id: positionId.toUpperCase(), company_id: companyId.toUpperCase(),
  }, companyId, positionId), true);
});

test('SC-014/016 exercise context rejects mismatched and malformed Data API rows', () => {
  for (const invalid of [null, [], {}, { ...recruitment(), id: otherId },
    { ...recruitment(), company_id: otherId }, { ...recruitment(), position_id: 'not-uuid' },
    { ...recruitment(), position_id: null }, { ...recruitment(), id: 42 }]) {
    assert.equal(exerciseRecruitmentMatches(invalid, companyId, recruitmentId), false);
  }
  for (const invalid of [null, [], {}, { ...position(), id: otherId },
    { ...position(), company_id: otherId }, { ...position(), company_id: null }]) {
    assert.equal(exercisePositionMatches(invalid, companyId, positionId), false);
  }
  assert.equal(exerciseRecruitmentMatches(recruitment(), otherId, recruitmentId), false);
  assert.equal(exerciseRecruitmentMatches(recruitment(), companyId, otherId), false);
  assert.equal(exercisePositionMatches(position(), companyId, otherId), false);
  assert.equal(exercisePositionMatches(position(), 'not-uuid', positionId), false);
});

test('the exercise page binds both RLS API responses before using their data', () => {
  const source = readFileSync(new URL('../lib/exercise-context.ts', import.meta.url), 'utf8');
  assert.match(source, /exerciseRecruitmentMatches\(recruitment\.data, companyId, recruitmentId\)/);
  assert.match(source, /exercisePositionMatches\(position\.data, companyId, recruitment\.data\.position_id\)/);
  assert.ok(source.indexOf('exerciseRecruitmentMatches(') < source.indexOf("client.from('positions')"));
  assert.ok(source.indexOf('exercisePositionMatches(') < source.indexOf('return { ...access'));
});
