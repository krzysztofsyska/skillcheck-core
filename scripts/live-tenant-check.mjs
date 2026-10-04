import assert from 'node:assert/strict';

export const tenantTables = [
  'companies', 'company_members', 'company_profiles', 'positions', 'recruitments',
  'candidates', 'applications', 'assessment_stages', 'candidate_assessments', 'candidate_documents',
  'behavior_assessment_entries', 'latest_behavior_assessments',
  'exercise_definition_entries', 'latest_exercise_definitions',
];

// A hidden foreign row is evidence only if its owner can actually read it.
// Query only the tenant key; never load names, contact details or CV contents.
export async function checkTenantReads(clients, firms) {
  assert.equal(clients.length, 2, 'Test wymaga dwóch sesji.');
  assert.ok(firms.length === 2 && firms.every(ids => ids.length > 0), 'Test wymaga dwóch istniejących firm.');
  assert.ok(firms[0].every(id => !firms[1].includes(id)), 'Konta testowe muszą należeć do różnych firm.');

  for (const table of tenantTables) {
    const column = table === 'companies' ? 'id' : 'company_id';
    for (const [index, client] of clients.entries()) {
      const response = await client.from(table).select(column).in(column, firms[index]).limit(1);
      assert.ok(!response.error && Array.isArray(response.data), `Błąd odczytu własnej tabeli ${table}, konto ${index === 0 ? 'A' : 'B'}.`);
      assert.ok(response.data.length > 0, `Niepełny test: tabela ${table} nie zawiera widocznego rekordu firmy konta ${index === 0 ? 'A' : 'B'}. Przygotuj dane testowe; pusta tabela nie potwierdza RLS.`);
    }
    for (const [index, client] of clients.entries()) {
      const response = await client.from(table).select(column).in(column, firms[1 - index]).limit(1);
      assert.ok(!response.error && Array.isArray(response.data), `Błąd odczytu obcej tabeli ${table}.`);
      assert.equal(response.data.length, 0, `Izolacja firm nie działa: ${table}.`);
    }
  }
}
