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

// Advisory validation of CALLER-SUPPLIED evidence. Linked SHA values detect
// internally inconsistent ranges, but do not authenticate the Git object graph.
// Status/mode metadata CANNOT detect secrets hidden in permitted file blobs.
// Only a future trusted main-side verifier may enumerate actual Git commits,
// inspect historical blobs, and enforce a Production release rule.
const shaPattern = /^[0-9a-f]{40}$/;
export function validateSalesRelease({
  files, statuses, modes, commits, base, headRef, baseSha, headSha,
}) {
  const errors = [];
  if (base !== 'main') errors.push('Expected main target');
  if (!branchPattern.test(headRef ?? '')) errors.push('Unexpected release branch');
  inspectChanges(files, statuses, modes, errors, 'final');
  if (!files?.includes('app/preselekcja/page.tsx')) errors.push('Intake page required');
  if (!shaPattern.test(baseSha ?? '') || !shaPattern.test(headSha ?? '') || baseSha === headSha) {
    errors.push('Require distinct base/head SHA-1 identifiers');
  }
  if (!Array.isArray(commits) || commits.length === 0 || commits.length > 30) {
    errors.push('Entire commit history must be verified (1–30 commits)');
  } else {
    let previousSha = baseSha;
    const seenCommits = new Set();
    const touched = new Set();
    for (let i=0; i<commits.length; i+=1) {
      const commit = commits[i];
      if (!commit || commit.parentCount !== 1) {
        errors.push('Merge/root commit forbidden in supplied sales release history ' + i);
        continue;
      }
      if (!shaPattern.test(commit.sha ?? '') || !shaPattern.test(commit.parentSha ?? '') ||
          commit.sha === commit.parentSha || commit.parentSha !== previousSha ||
          seenCommits.has(commit.sha)) {
        errors.push('Broken or duplicate supplied commit chain at ' + i);
      }
      previousSha = commit.sha;
      seenCommits.add(commit.sha);
      const changes = commit.changes;
      if (!Array.isArray(changes)) {
        errors.push('Missing supplied per-commit diff ' + i);
        continue;
      }
      inspectChanges(
        changes.map(c => c?.path),
        changes.map(c => c?.status),
        changes.map(c => c?.mode),
        errors, 'commit '+i,
      );
      for (const change of changes) touched.add(change?.path);
    }
    if (previousSha !== headSha) errors.push('Supplied commit chain does not reach head SHA');
    for (const path of files ?? []) {
      if (!touched.has(path)) errors.push('Final file missing from supplied history: ' + path);
    }
  }
  // Both booleans are intentionally FALSE: the caller's hashes are not
  // authenticated against Git objects and historical blob contents are not scanned.
  // A green result is advisory scope consistency, NEVER Production permission.
  return {
    ok: errors.length === 0,
    historyAuthenticated: false,
    secretsScanned: false,
    authorizedForProduction: false,
    errors,
  };
}

export function isSalesReleaseBranch(headRef) {
  return branchPattern.test(headRef ?? '');
}
