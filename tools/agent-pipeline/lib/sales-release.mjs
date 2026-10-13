// Read-only, preparation-only validator. NEVER a Production authorization.
// The ACTIVE main gate still rejects standalone release branches. A future
// production verifier must execute from the protected base revision, not PR code.
export const SALES_INTAKE_FILES = Object.freeze([
  'app/preselekcja/page.tsx',
  'app/components/marketing/home-page.tsx',
  'app/components/marketing/site-header.tsx',
  'app/components/marketing/package-comparison.tsx',
  'tests/marketing-http.test.mjs',
]);

const allowed = new Set(SALES_INTAKE_FILES);
const branchPattern = /^release\/sales-mvp-intake-[0-9]{8}(?:-[a-z0-9-]+)?$/;

function validPath(path) {
  return typeof path === 'string' && allowed.has(path)
    && !path.startsWith('/') && !path.includes('\\')
    && !path.split('/').some(part => !part || part === '.' || part === '..');
}

function inspectChanges(paths, statuses, modes, errors, label) {
  if (!Array.isArray(paths) || paths.length < 1) {
    errors.push(label + ': missing diff');
    return;
  }
  if (!Array.isArray(statuses) || !Array.isArray(modes) ||
      statuses.length !== paths.length || modes.length !== paths.length) {
    errors.push(label + ': missing status/mode evidence');
    return;
  }
  const seen = new Set();
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (!validPath(path)) errors.push(label + ': forbidden file ' + String(path));
    if (seen.has(path)) errors.push(label + ': duplicate file ' + path);
    seen.add(path);
    if (!['A','M'].includes(statuses[index])) errors.push(label + ': forbidden status ' + String(statuses[index]));
    if (modes[index] !== '100644') errors.push(label + ': forbidden mode ' + String(modes[index]));
  }
}

// This verifies FINAL diff plus EVERY INTERMEDIATE commit, preventing a
// malicious temporary secret, symlink, deletion or submodule from entering main
// via merge-commit history. It checks scope, NOT identity or authorization.
export function validateSalesRelease({ files, statuses, modes, commits, base, headRef }) {
  const errors = [];
  if (base !== 'main') errors.push('Expected main target');
  if (!branchPattern.test(headRef ?? '')) errors.push('Unexpected release branch');
  inspectChanges(files, statuses, modes, errors, 'final');
  if (!files?.includes('app/preselekcja/page.tsx')) errors.push('Intake page required');
  if (!Array.isArray(commits) || commits.length === 0 || commits.length > 30) {
    errors.push('Entire commit history must be verified (1–30 commits)');
  } else {
    for (let i=0; i<commits.length; i+=1) {
      const commit = commits[i];
      if (!commit || commit.parentCount !== 1) {
        errors.push('Merge/root commit forbidden in sales release history ' + i);
        continue;
      }
      const changes = commit.changes;
      if (!Array.isArray(changes)) {
        errors.push('Missing per-commit diff ' + i);
        continue;
      }
      inspectChanges(
        changes.map(c => c?.path),
        changes.map(c => c?.status),
        changes.map(c => c?.mode),
        errors, 'commit '+i,
      );
    }
  }
  // This flag explicitly bars treating a metadata string or green CI as a
  // Production decision. Separate verified owner acceptance and Production
  // environment approval are required AFTER a trusted main-side bootstrap.
  return { ok: errors.length === 0, authorizedForProduction: false, errors };
}

export function isSalesReleaseBranch(headRef) {
  return branchPattern.test(headRef ?? '');
}
