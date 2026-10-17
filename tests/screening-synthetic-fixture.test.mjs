import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evidenceFromExactQuotes } from '../lib/screening-ai.ts';
import { prepareScreening } from '../lib/screening.ts';

const fixtureUrl = new URL('../fixtures/screening/sc-005-synthetic.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

test('synthetic SC-005 fixture is fictional and quote offsets are exact UTF-16 indexes', async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.real_person, false);
  assert.equal(fixture.contains_contact_data, false);
  assert.equal(fixture.cv_text.includes('@'), false);
  assert.doesNotMatch(fixture.cv_text, /\+?\d[\d\s-]{8,}/);
  const evidence = evidenceFromExactQuotes(
    fixture.cv_text,
    fixture.expected_evidence.map(item => item.quote),
  );
  assert.deepEqual(
    evidence,
    fixture.expected_evidence.map(item => ({ start: item.start, end: item.end, quote: item.quote })),
  );
  for (const item of fixture.expected_evidence) {
    assert.equal(fixture.cv_text.slice(item.start, item.end), item.quote);
  }
});

test('synthetic criteria match the screening allowlist for one task and one KPI', async () => {
  const fixture = await loadFixture();
  const now = '2026-10-07T00:00:00.000Z';
  const prepared = prepareScreening({
    companyId: '00000000-0000-4000-8000-000000000001',
    application: {
      id: '00000000-0000-4000-8000-000000000002',
      company_id: '00000000-0000-4000-8000-000000000001',
      recruitment_id: '00000000-0000-4000-8000-000000000003',
      candidate_id: '00000000-0000-4000-8000-000000000004',
      status: 'in_progress',
      updated_at: now,
    },
    recruitment: {
      id: '00000000-0000-4000-8000-000000000003',
      company_id: '00000000-0000-4000-8000-000000000001',
      position_id: '00000000-0000-4000-8000-000000000005',
      status: 'open',
      updated_at: now,
    },
    position: {
      id: '00000000-0000-4000-8000-000000000005',
      company_id: '00000000-0000-4000-8000-000000000001',
      status: 'active',
      tasks: fixture.position.tasks,
      kpis: fixture.position.kpis,
      required_competencies: fixture.position.required_competencies,
      updated_at: now,
    },
    document: {
      id: '00000000-0000-4000-8000-000000000006',
      company_id: '00000000-0000-4000-8000-000000000001',
      candidate_id: '00000000-0000-4000-8000-000000000004',
      version: 1,
      status: 'reviewed',
      reviewed_by: '00000000-0000-4000-8000-000000000007',
      reviewed_at: now,
      redacted_text: fixture.cv_text,
    },
  });
  assert.deepEqual(prepared.payload.criteria, fixture.criteria);
  assert.equal(prepared.payload.cv_text, fixture.cv_text);
  assert.equal(prepared.payload.schema_version, 1);
  assert.equal(JSON.stringify(prepared.payload).includes('00000000-'), false);
});
