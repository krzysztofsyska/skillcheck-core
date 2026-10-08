import { readFile } from 'node:fs/promises';
import { evidenceFromExactQuotes } from '../lib/screening-ai.ts';

// Local fixture check for SC-005. This file does not call Supabase, OpenAI or Vercel,
// does not read secret values, and does not change SCREENING_AI_ENABLED.
const fixture = JSON.parse(await readFile(new URL('../fixtures/screening/sc-005-synthetic.json', import.meta.url), 'utf8'));

if (process.argv.includes('--execute')) {
  console.error('BLOCKED: production smoke stays stopped until the owner approves it.');
  console.error('READY FOR SC-005 PRODUCTION SMOKE APPROVAL');
  process.exit(2);
}

const evidence = evidenceFromExactQuotes(fixture.cv_text, fixture.expected_evidence.map(item => item.quote));
const offsetsMatch = fixture.expected_evidence.every((item, index) => {
  const actual = evidence[index];
  return actual.start === item.start && actual.end === item.end && actual.quote === item.quote
    && fixture.cv_text.slice(item.start, item.end) === item.quote;
});
if (!fixture.real_person && fixture.contains_contact_data === false && offsetsMatch && fixture.criteria.length === 2) {
  console.log(`local-fixture-ok ${fixture.id} criteria=${fixture.criteria.length}`);
  process.exit(0);
}
console.error('Synthetic fixture failed the local quote check.');
process.exit(1);
