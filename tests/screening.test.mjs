import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareScreening, assertScreeningCurrent, validateScreeningFindings } from '../lib/screening.ts';

function context() {
  const common = { company_id: 'company-a', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' };
  return {
    companyId: 'company-a',
    application: { ...common, id: 'application-a', candidate_id: 'candidate-a', recruitment_id: 'recruitment-a', status: 'new' },
    recruitment: { ...common, id: 'recruitment-a', position_id: 'position-a', status: 'open', name: 'Rekrutacja', opened_at: null, closed_at: null },
    position: { ...common, id: 'position-a', title: 'Analityk', description: 'Internal description should not leave the app', tasks: ['Analiza danych'], kpis: ['Terminowość raportów'], required_competencies: ['SQL'], required_behaviors: ['Odpowiedzialność: Wysoki'], autonomy_level: 3, status: 'active' },
    document: { ...common, id: 'document-a', candidate_id: 'candidate-a', version: 2, status: 'reviewed', reviewed_by: 'reviewer-a', reviewed_at: '2026-10-01T10:00:00Z', redacted_text: 'Przygotowuję raporty w SQL.', source_text: 'Jan Kowalski jan@example.invalid' },
  };
}
const noData = prepared => prepared.payload.criteria.map(item => ({ criterion_id: item.id, level: 'insufficient_data', evidence: [] }));
const quote = { start: 0, end: 26, quote: 'Przygotowuję raporty w SQL.' };

test('screening payload includes only reviewed text and job criteria, excluding identity and behavior inference', () => {
  const prepared = prepareScreening(context());
  assert.deepEqual(Object.keys(prepared.payload), ['schema_version', 'cv_text', 'criteria']);
  assert.deepEqual(prepared.payload.criteria.map(c => c.id), ['task:1', 'kpi:1', 'competency:1']);
  const serialized = JSON.stringify(prepared.payload);
  for (const privateValue of ['Jan', 'jan@example', 'company-a', 'candidate-a', 'reviewer-a', 'Internal description', 'Odpowiedzialność']) assert.ok(!serialized.includes(privateValue));
  assert.equal(prepared.binding.application_id, 'application-a');
  assert.match(prepared.fingerprint, /^[a-f0-9]{64}$/);
});

test('screening rejects unreviewed, absent, invalid CV and incomplete position requirements', () => {
  for (const change of [
    c => { c.document = null; }, c => { c.document.status = 'draft'; },
    c => { c.document.reviewed_by = null; }, c => { c.document.reviewed_at = null; },
    c => { c.document.version = 0; }, c => { c.document.redacted_text = ' '; },
    c => { c.document.redacted_text = 'x'.repeat(100001); },
    c => { c.position.tasks = []; }, c => { c.position.kpis = []; },
    c => { c.position.required_competencies = ['x'.repeat(501)]; },
  ]) { const c = context(); change(c); assert.throws(() => prepareScreening(c)); }
});

test('screening rejects mismatched tenant, candidate, recruitment and position', () => {
  for (const entity of ['application', 'recruitment', 'position', 'document']) {
    const c = context(); c[entity].company_id = 'company-b'; assert.throws(() => prepareScreening(c), /połączyć/);
  }
  for (const [entity, field] of [['document', 'candidate_id'], ['application', 'recruitment_id'], ['recruitment', 'position_id']]) {
    const c = context(); c[entity][field] = 'foreign'; assert.throws(() => prepareScreening(c), /połączyć/);
  }
});

test('screening blocks withdrawn/decided applications and closed/paused recruitment', () => {
  for (const status of ['withdrawn', 'rejected', 'hired']) {
    const c = context(); c.application.status = status; assert.throws(() => prepareScreening(c), /zakończone/);
  }
  for (const status of ['paused', 'closed']) {
    const c = context(); c.recruitment.status = status; assert.throws(() => prepareScreening(c), /wstrzymana/);
  }
  const c = context(); c.position.status = 'archived'; assert.throws(() => prepareScreening(c), /zarchiwizowane/);
});

test('freshness binding rejects CV replacement, edits, withdrawn approval and changes to requirements', () => {
  const prepared = prepareScreening(context());
  assert.doesNotThrow(() => assertScreeningCurrent(prepared, context()));
  for (const change of [
    c => { c.document.version++; }, c => { c.document.id = 'new-document'; },
    c => { c.document.redacted_text += ' Zmiana.'; }, c => { c.document.status = 'draft'; },
    c => { c.position.tasks[0] = 'Nowe zadanie'; }, c => { c.position.updated_at = 'new-time'; },
    c => { c.application.updated_at = 'new-time'; }, c => { c.application.status = 'withdrawn'; },
    c => { c.recruitment.status = 'closed'; },
  ]) { const current = context(); change(current); assert.throws(() => assertScreeningCurrent(prepared, current)); }
});

test('findings distinguish insufficient information from a supported evaluation', () => {
  const prepared = prepareScreening(context());
  const findings = noData(prepared);
  findings[0] = { criterion_id: 'task:1', level: 'meets', evidence: [{ ...quote, end: quote.quote.length }] };
  assert.deepEqual(validateScreeningFindings(findings, prepared), findings);
  findings[1].level = 'below';
  assert.throws(() => validateScreeningFindings(findings, prepared), /Brak informacji/);
});

test('findings reject fabricated quotes, offsets, extra decisions, duplicate/missing/unknown criteria', () => {
  const prepared = prepareScreening(context());
  for (const change of [
    rows => rows.pop(), rows => { rows[0].criterion_id = 'other'; },
    rows => { rows[0].criterion_id = rows[1].criterion_id; },
    rows => { rows[0].decision = 'hire'; }, rows => { rows[0].level = 'hire'; },
    rows => { rows[0].evidence = [{ ...quote, end: quote.quote.length, quote: 'Zmyślony cytat' }]; },
    rows => { rows[0].evidence = [{ ...quote, start: -1 }]; },
    rows => { rows[0].evidence = [{ ...quote, end: 9999 }]; },
    rows => { rows[0].evidence = [{ ...quote, start: 0.5 }]; },
    rows => { rows[0].evidence = [null]; },
    rows => { rows[0] = null; },
  ]) { const findings = noData(prepared); change(findings); assert.throws(() => validateScreeningFindings(findings, prepared)); }
  for (const invalid of [null, {}, 'text', []]) assert.throws(() => validateScreeningFindings(invalid, prepared));
});
