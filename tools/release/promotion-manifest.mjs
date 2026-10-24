#!/usr/bin/env node
// Offline, read-only promotion manifest generator.
// Attributes every commit in BASE..HEAD (default origin/main..origin/integration)
// to the integration PR that introduced it, by walking first-parent history.
// It reads only local git objects. It never authorizes a release: the output is
// evidence for owner review, and the controller's ACCEPTED ledger stays authoritative.
//
// Usage: node tools/release/promotion-manifest.mjs [--base origin/main] [--head origin/integration]
//        [--pulls pulls.json] [--json out.json] [--md out.md]
// The clone must contain full history for BASE..HEAD (git fetch --depth large enough).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, index, all) => {
  if (value.startsWith('--')) acc.push([value.slice(2), all[index + 1]]);
  return acc;
}, []));
const base = args.base ?? 'origin/main';
const head = args.head ?? 'origin/integration';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const lines = text => (text ? text.split('\n') : []);

export function prNumberFromSubject(subject) {
  const match = /(?:Merge pull request #|PR #|\(#|\(PR #)(\d+)/.exec(subject);
  return match ? Number(match[1]) : null;
}

export function classifyFile(path) {
  if (path.startsWith('supabase/migrations/')) return 'migration';
  if (path.startsWith('supabase/')) return 'supabase-other';
  if (path.startsWith('.github/')) return 'ci-governance';
  if (path.startsWith('app/api/')) return 'api';
  if (path.startsWith('app/') || path.startsWith('components/') || path.startsWith('public/')) return 'frontend';
  if (path.startsWith('lib/') || path.startsWith('db/') || path === 'proxy.ts') return 'backend';
  if (path.startsWith('tools/') || path.startsWith('scripts/')) return 'tooling';
  if (path.startsWith('tests/') || path.startsWith('fixtures/')) return 'tests';
  if (path.startsWith('docs/') || path.endsWith('.md')) return 'docs';
  if (['package.json', 'package-lock.json', 'vercel.json', 'next.config.mjs', 'tsconfig.json'].includes(path)) return 'runtime-config';
  return 'other';
}

function build() {
  const baseSha = git('rev-parse', base);
  const headSha = git('rev-parse', head);
  const mergeBase = git('merge-base', baseSha, headSha);
  if (mergeBase !== baseSha) throw new Error(`PROMOTION_HISTORY_DIVERGED: merge-base ${mergeBase} != base ${baseSha}`);
  const all = new Set(lines(git('rev-list', `${baseSha}..${headSha}`)));
  const firstParent = lines(git('log', '--first-parent', '--format=%H%x09%P%x09%s', `${baseSha}..${headSha}`))
    .map(line => { const [sha, parents, subject] = line.split('\t'); return { sha, parents: parents.split(' '), subject }; })
    .reverse();
  const owner = new Map();
  const entries = [];
  for (const step of firstParent) {
    const pr = prNumberFromSubject(step.subject);
    const commits = step.parents.length > 1
      ? lines(git('rev-list', step.parents[1], `^${step.parents[0]}`, `^${baseSha}`))
      : [];
    commits.push(step.sha);
    for (const sha of commits) if (!owner.has(sha)) owner.set(sha, step.sha);
    const files = lines(git('diff', '--name-only', step.parents[0], step.sha));
    entries.push({ step_sha: step.sha, kind: step.parents.length > 1 ? 'merge' : 'single', pr, subject: step.subject,
      commit_count: commits.filter(sha => owner.get(sha) === step.sha).length, files });
  }
  const unattributed = [...all].filter(sha => !owner.has(sha));
  const files = lines(git('diff', '--name-only', baseSha, headSha)).sort();
  const migrations = files.filter(f => f.startsWith('supabase/migrations/') && f.endsWith('.sql'));
  const categories = {};
  for (const f of files) categories[classifyFile(f)] = (categories[classifyFile(f)] ?? 0) + 1;
  const manifest = { base_ref: base, head_ref: head, base_sha: baseSha, head_sha: headSha,
    commit_count: all.size, attributed_count: all.size - unattributed.length, unattributed,
    steps: entries, files, file_categories: categories, migrations_added: migrations.filter(f =>
      !lines(git('ls-tree', '-r', '--name-only', baseSha, 'supabase/migrations/')).includes(f)) };
  manifest.manifest_hash = createHash('sha256').update(JSON.stringify({ ...manifest, steps: entries.map(({ files, ...r }) => r) })).digest('hex');
  return manifest;
}

function markdown(m, pulls) {
  const out = [];
  out.push(`# Manifest promocji ${m.head_ref} → ${m.base_ref}`, '');
  out.push('Wygenerowano narzędziem `tools/release/promotion-manifest.mjs` (tylko odczyt lokalnego Git).', '');
  out.push(`- Kandydat (head): \`${m.head_sha}\``, `- Produkcja (base): \`${m.base_sha}\``);
  out.push(`- Commity: **${m.commit_count}**, przypisane do PR: **${m.attributed_count}**, nieprzypisane: **${m.unattributed.length}**`);
  out.push(`- Pliki: **${m.files.length}**; nowe migracje: **${m.migrations_added.length}**`);
  out.push(`- Hash manifestu (sha256): \`${m.manifest_hash}\``, '');
  out.push('Manifest jest dowodem do przeglądu właściciela. Nie zastępuje rejestru ACCEPTED kontrolera i niczego nie autoryzuje.', '');
  out.push('## Kategorie plików', '', '| Kategoria | Pliki |', '| --- | ---: |');
  for (const [k, v] of Object.entries(m.file_categories).sort((a, b) => b[1] - a[1])) out.push(`| ${k} | ${v} |`);
  out.push('', '## Nowe migracje (kolejność repozytorium)', '');
  m.migrations_added.forEach((f, i) => out.push(`${i + 1}. \`${f}\``));
  out.push('', '## Kroki historii integration (chronologicznie)', '', '| # | Commit | PR | Commity | Migracje | Tytuł PR |', '| ---: | --- | --- | ---: | :---: | --- |');
  m.steps.forEach((s, i) => {
    const pull = s.pr ? pulls[s.pr] : null;
    const title = (pull?.title ?? s.subject).replace(/\|/g, '\\|');
    const touchesMigrations = s.files.some(f => f.startsWith('supabase/migrations/')) ? 'tak' : '';
    out.push(`| ${i + 1} | \`${s.step_sha.slice(0, 7)}\` | ${s.pr ? `#${s.pr}` : '—'} | ${s.commit_count} | ${touchesMigrations} | ${title} |`);
  });
  if (m.unattributed.length) {
    out.push('', '## Commity nieprzypisane (wymagają wyjaśnienia)', '');
    for (const sha of m.unattributed) out.push(`- \`${sha}\``);
  }
  out.push('');
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = build();
  const pulls = args.pulls ? JSON.parse(readFileSync(args.pulls, 'utf8')) : {};
  if (args.json) writeFileSync(args.json, `${JSON.stringify(manifest, null, 2)}\n`);
  if (args.md) writeFileSync(args.md, markdown(manifest, pulls));
  if (!args.json && !args.md) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  if (manifest.unattributed.length) process.exitCode = 2;
}
