// SC-FORM-RESET-AUDIT (#367): React 19 resets uncontrolled form fields after every form
// action, including one that returned { error }. These forms keep what the user typed after
// a rejected save and still reset after a successful one. Static check of the pattern.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const base = 'app/dashboard/[companyId]/recruitments/[recruitmentId]';
// [file, form action identifier, ref that remembers whether the last save succeeded]
const forms = [
  [`${base}/applications/[applicationId]/followup/forms.tsx`, 'action', 'saved'],
  [`${base}/bulk/groups.tsx`, 'action', 'saved'],
  [`${base}/applications/[applicationId]/screening/controls.tsx`, 'submit', 'saved'],
  [`${base}/assessment-forms.tsx`, 'rename', 'renameSaved'],
  [`${base}/assessment-forms.tsx`, 'action', 'saved'],
  [`${base}/exercise-ai-approval.tsx`, 'action', 'saved'],
];

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const [file, action, ref] of forms) {
  test(`${file} keeps typed values after a rejected save (${action})`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`const ${escape(ref)}\\s*=\\s*useRef\\(false\\)`), 'ref remembering the last save');
    assert.match(source, new RegExp(`${escape(ref)}\\.current\\s*=\\s*(?:!next\\.error|Boolean\\(next\\.saved\\))`),
      'ref is set from the server action result');
    const form = new RegExp(`<form action=\\{${escape(action)}\\} onReset=\\{\\s*event\\s*=>\\s*\\{\\s*if\\s*\\(\\s*!${escape(ref)}\\.current\\s*\\)\\s*event\\.preventDefault\\(\\);?\\s*\\}\\s*\\}`);
    assert.match(source, form, 'reset is cancelled only after a rejected save');
  });
}
