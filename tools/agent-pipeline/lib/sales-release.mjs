// SALES-MVP-RELEASE: narrow PR scope policy, not a deployment authorization.
// Only pilot inquiry pages. No payment, billing, worker, database or config files.
export const SALES_INTAKE_FILES = Object.freeze([
  'app/preselekcja/page.tsx',
  'app/components/marketing/home-page.tsx',
  'app/components/marketing/site-header.tsx',
  'app/components/marketing/package-comparison.tsx',
  'tests/marketing-http.test.mjs',
]);

const allow = new Set(SALES_INTAKE_FILES);
const branchPattern = /^release\/sales-mvp-intake-[0-9]{8}(?:-[a-z0-9-]+)?$/;
const valid = Object.freeze({ base: 'main', releaseKind: 'SALES_MVP_INTAKE' });

function pathSafe(path) {
  return typeof path === 'string' && path.length > 0 &&
    !path.startsWith('/') && !path.includes('\\') &&
    !path.split('/').some(part => part === '.' || part === '..' || part === '');
}

export function validateSalesRelease({ files, statuses, modes, base, headRef, metadata = {} }) {
  const errors = [];
  if (base !== valid.base) errors.push('Sales release must target main');
  if (!branchPattern.test(headRef ?? '')) errors.push('Unexpected sales release branch');
  if (metadata.PROMOTION !== 'YES') errors.push('PROMOTION must be YES');
  if (metadata.RELEASE_KIND !== valid.releaseKind) errors.push('RELEASE_KIND must be SALES_MVP_INTAKE');
  if (metadata.LEVEL !== 'L3') errors.push('Sales release requires L3');
  if (metadata.PRODUCTION_APPROVAL !== 'APPROVED') {
    errors.push('Production approval required before sales-release promotion');
  }
  // Textual metadata is NOT trusted proof of approval. A protected GitHub
  // environment and branch rules, plus independent review, are mandatory.
  if (!Array.isArray(files) || files.length < 1) {
    errors.push('Empty or invalid release diff');
  } else {
    const seen = new Set();
    for (const path of files) {
      if (!pathSafe(path) || !allow.has(path)) errors.push('File not allowed: ' + String(path));
      if (seen.has(path)) errors.push('Duplicate file: ' + path);
      seen.add(path);
    }
    if (!seen.has('app/preselekcja/page.tsx')) errors.push('Sales intake page is required');
    if (!Array.isArray(statuses) || statuses.length !== files.length) {
      errors.push('Changed-file status verification required');
    } else {
      for (let i = 0; i < files.length; i += 1) {
        if (!['A', 'M'].includes(statuses[i])) {
          errors.push('Only added/modified regular files allowed: ' + files[i]);
        }
      }
    }
    if (!Array.isArray(modes) || modes.length !== files.length) {
      errors.push('Tracked file modes verification required');
    } else {
      for (let i = 0; i < files.length; i += 1) {
        if (modes[i] !== '100644') errors.push('Only regular non-executable files allowed: ' + files[i]);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function isSalesReleaseBranch(headRef) {
  return branchPattern.test(headRef ?? '');
}
